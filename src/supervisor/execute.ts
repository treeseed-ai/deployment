import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { generateEdgeCertificate } from '../edge/certificates.js';
import { assertNewGeneration, loadHostConfiguration, tryLoadHostConfiguration } from '../core/configuration.js';
import { enrollClient } from './pki.js';
import { configureComponent, resolveDevelopmentSecretEnvironment, restoreComponentSecretFiles } from './component.js';
import { createGenerationBackup, inspectGenerationBackup, listGenerationBackups, restoreGenerationBackup } from './backup.js';
import { resetPlatformState } from './reset.js';

export type CommandRunner = (executable: string, arguments_: readonly string[], input?: string) => unknown;
const run: CommandRunner = (executable, arguments_, input) => {
	const output = execFileSync(executable, [...arguments_], { stdio: input === undefined ? 'inherit' : ['pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input, encoding: 'utf8' }), env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } });
	return typeof output === 'string' ? output : undefined;
};

function enrollmentReceipt(output: unknown, connectionId: string) {
	if (typeof output !== 'string' || output.trim().length === 0) throw new Error('Provider enrollment returned no receipt.');
	const receipt = JSON.parse(output) as unknown;
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Provider enrollment returned an invalid receipt.');
	const result = receipt as Record<string, unknown>;
	if (result.connectionId !== connectionId) throw new Error('Provider enrollment receipt did not match the requested connection.');
	return result;
}

function bundledComposeFiles(files: readonly string[]) {
	return files.flatMap((file) => {
		const absolute = resolve(paths.bundles, file), root = resolve(paths.bundles);
		if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Compose file is outside the packaged component root.');
		return ['--file', absolute];
	});
}

function componentComposeArguments(componentId: string, files: readonly string[]) {
	return ['--env-file', `/etc/treeseed/components/${componentId}/environment`, ...bundledComposeFiles(files)];
}

function composeProjectContainerIds(projectName: string, command: CommandRunner, runningOnly = false) {
	const output = command('/usr/bin/docker', [
		'ps', ...(runningOnly ? [] : ['--all']), '--quiet', '--filter', `label=com.docker.compose.project=${projectName}`,
	], '');
	return typeof output === 'string' ? output.trim().split(/\s+/u).filter(Boolean) : [];
}

function ensureNetwork(name: 'treeseed-platform' | 'treeseed-edge', command: CommandRunner) {
	try { command('/usr/bin/docker', ['network', 'inspect', name]); }
	catch { command('/usr/bin/docker', ['network', 'create', '--driver', 'bridge', '--label', 'org.treeseed.manager=true', name]); }
}

function resetUnacceptedComponentState(componentId: string) {
	if (existsSync(`${paths.managerState}/current-receipt.json`) || existsSync(`${paths.managerState}/active-components.json`)) throw new Error('Accepted component state cannot be reset by bootstrap recovery.');
	const root = resolve(paths.components), target = resolve(root, componentId);
	if (!target.startsWith(`${root}${sep}`)) throw new Error('Component state reset escaped the managed state root.');
	rmSync(target, { recursive: true, force: true });
}

export function recoverInvalidConfiguration(configuration: SupervisorOperation & { operation: 'configuration.recover' }, configurationPath: string = paths.configuration, archiveRoot: string = `${paths.managerState}/invalid-configurations`) {
	if (tryLoadHostConfiguration(configurationPath)) throw new Error('Configuration recovery is only available when the installed configuration is invalid.');
	const raw = readFileSync(configurationPath, 'utf8');
	mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
	const archive = `${archiveRoot}/${Date.now()}-${process.pid}.json.invalid`;
	writeFileSync(archive, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	atomicJson(configurationPath, configuration.configuration, 0o640);
	return { recovered: true, archive };
}

export function executeSupervisorOperation(input: unknown, command: CommandRunner = run, restoreSecrets: (componentId: string) => unknown = restoreComponentSecretFiles) {
	if (process.getuid?.() !== 0 && command === run) throw new Error('TreeSeed supervisor must run as root.');
	const operation: SupervisorOperation = supervisorOperationSchema.parse(input);
	switch (operation.operation) {
		case 'supervisor.ping': return { ready: true };
		case 'apt.refresh':
		case 'apt.install':
			atomicJson(`${paths.managerState}/pending-packages.json`, operation, 0o600);
			command('/usr/bin/systemctl', ['start', 'treeseed-manager-apt-helper.service']);
			if (operation.operation === 'apt.refresh' && existsSync(`${paths.managerState}/last-apt-result.json`)) return JSON.parse(readFileSync(`${paths.managerState}/last-apt-result.json`, 'utf8')) as unknown;
			break;
		case 'component.configure': configureComponent(operation.componentId, operation.connectionEnvironment, operation.secretFileIds ?? []); break;
		case 'development.environment': return { environment: resolveDevelopmentSecretEnvironment(loadHostConfiguration(), operation.componentId, operation.secretRefs, operation.connectionEnvironment) };
		case 'component.reset-unaccepted': resetUnacceptedComponentState(operation.componentId); break;
		case 'provider.enroll': {
			const marker = `${paths.managerState}/provider-enrollments/${operation.connectionId}.json`;
			if (existsSync(marker)) return JSON.parse(readFileSync(marker, 'utf8')) as unknown;
			const secretPath = `/etc/treeseed/credentials/${operation.registrationSecretId}`;
			const enrollmentToken = readFileSync(secretPath, 'utf8').replace(/\r?\n$/u, '');
			if (!enrollmentToken) throw new Error('Provider registration credential is empty.');
			const input = `${JSON.stringify({ action: 'begin', connectionId: operation.connectionId, teamId: operation.teamId, controlPlaneUrl: operation.controlPlaneUrl, controlPlaneAudience: operation.controlPlaneAudience, enrollmentToken })}\n`;
			command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input);
			unlinkSync(secretPath);
			const result = { connectionId: operation.connectionId, state: 'pending-approval', oneTimeCredentialRemoved: true };
			atomicJson(marker, result, 0o600);
			return result;
		}
		case 'provider.enrollment-handoff': {
			const input = `${JSON.stringify(operation.payload)}\n`;
			const output = command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input);
			return enrollmentReceipt(output, operation.payload.connectionId);
		}
		case 'compose.activate':
			ensureNetwork('treeseed-platform', command);
			try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', String(operation.waitTimeoutSeconds)]); }
			catch (error) { restoreSecrets(operation.componentId); throw error; }
			break;
		case 'compose.stop': try {
			try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'stop']); }
			catch (error) {
				if (composeProjectContainerIds(operation.projectName, command).length > 0) throw error;
			}
		} finally { restoreSecrets(operation.componentId); } break;
		case 'compose.status': {
			const containers = composeProjectContainerIds(operation.projectName, command);
			const running = composeProjectContainerIds(operation.projectName, command, true);
			return { present: containers.length > 0, running: running.length > 0, containers: containers.length, runningContainers: running.length };
		}
		case 'compose.remove': try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'down', '--remove-orphans']); } finally { restoreSecrets(operation.componentId); } break;
		case 'systemd.control': command('/usr/bin/systemctl', [operation.action, operation.unit]); break;
		case 'edge.apply': {
			const target = `${paths.edge}/Caddyfile`, temporary = `${target}.new`;
			mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
			writeFileSync(temporary, operation.caddyfile, { mode: 0o640 });
			generateEdgeCertificate(operation.aliases, command);
			command('/usr/bin/docker', ['compose', '--file', '/usr/share/treeseed/edge/compose.yml', 'run', '--rm', '--no-deps', 'caddy', 'caddy', 'validate', '--config', temporary, '--adapter', 'caddyfile']);
			renameSync(temporary, target);
			command('/usr/bin/systemctl', ['reload-or-restart', 'treeseed-edge.service']);
			break;
		}
		case 'backup.create': return createGenerationBackup(operation.generation, command);
		case 'backup.inspect': return inspectGenerationBackup(operation.generation);
		case 'backup.list': return listGenerationBackups();
		case 'recovery.restore': return restoreGenerationBackup(operation.generation, command);
		case 'platform.reset': {
			const result = resetPlatformState({ components: operation.componentDataRoot, componentConfiguration: '/etc/treeseed/components', managerState: paths.managerState, backups: paths.backups });
			// The supervisor performs deletion as root, but reconciliation and the
			// local manager API deliberately run as treeseed-manager. Restore their
			// custody before the supervisor records completion or reset continues.
			// Materialize the ledger first so the root completion event appends to
			// the manager-owned inode instead of recreating it as root.
			writeFileSync(`${paths.managerState}/events.jsonl`, '', { encoding: 'utf8', mode: 0o640 });
			command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState]);
			return result;
		}
		case 'cli.configure': {
			mkdirSync(paths.cli, { recursive: true, mode: 0o755 });
			writeFileSync(`${paths.cli}/api-base-url`, `${operation.controlPlaneUrl}\n`, { encoding: 'utf8', mode: 0o644 });
			writeFileSync(`${paths.cli}/localhost-ca.crt`, readFileSync(`${paths.tls}/ca.crt`), { mode: 0o644 });
			break;
		}
		case 'manager.restart': command('/usr/bin/systemctl', ['--no-block', 'start', 'treeseed-manager-restart.service']); break;
		case 'configuration.replace': {
			const current = loadHostConfiguration();
			assertNewGeneration(current, operation.configuration);
			atomicJson(paths.configuration, operation.configuration, 0o640);
			break;
		}
		case 'configuration.adopt': {
			const current = loadHostConfiguration();
			if (current.configurationId === operation.configuration.configurationId) throw new Error('Configuration adoption requires a different configuration identity.');
			atomicJson(`${paths.managerState}/adopted-configurations/${current.configurationId}-${current.generation}.json`, current, 0o600);
			atomicJson(paths.configuration, operation.configuration, 0o640);
			break;
		}
		case 'configuration.recover': return recoverInvalidConfiguration(operation);
		case 'pki.enroll': return enrollClient(operation.clientId, command);
	}
}
