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

const aiRuntime = {
	inference: { componentId: 'ai-inference', projectName: 'treeseed-ai-inference', gateService: 'inference-api', gpuServices: ['inference-vllm'] },
	training: { componentId: 'ai-training', projectName: 'treeseed-ai-training', gateService: 'training-api', gpuServices: ['training-marker', 'training-axolotl'] },
} as const;

function aiCompose(role: keyof typeof aiRuntime, files: readonly string[]) {
	const runtime = aiRuntime[role];
	return ['compose', ...componentComposeArguments(runtime.componentId, files), '--project-name', runtime.projectName];
}

function aiGate(role: keyof typeof aiRuntime, action: 'open' | 'close' | 'status', files: readonly string[], command: CommandRunner) {
	const runtime = aiRuntime[role];
	const output = command('/usr/bin/docker', [...aiCompose(role, files), 'exec', '-T', runtime.gateService, '/usr/local/bin/treeseed-ai-gpu-gate', action], '');
	if (typeof output !== 'string') throw new Error(`AI ${role} gate returned no status.`);
	const value = JSON.parse(output) as { admission?: unknown; active?: unknown };
	if ((value.admission !== 'open' && value.admission !== 'closed') || !Number.isInteger(value.active) || Number(value.active) < 0) throw new Error(`AI ${role} gate returned invalid status.`);
	return { role, admission: value.admission, active: Number(value.active) };
}

function aiWorkload(role: keyof typeof aiRuntime, action: 'start' | 'stop' | 'status' | 'warm', files: readonly string[], waitTimeoutSeconds: number, command: CommandRunner) {
	const runtime = aiRuntime[role], compose = aiCompose(role, files);
	if (action === 'warm') {
		if (role !== 'inference') throw new Error('Only the inference workload supports warming.');
		command('/usr/bin/docker', [...compose, 'exec', '-T', 'inference-vllm', '/usr/local/bin/treeseed-ai-warm'], '');
		return { role, action, ready: true };
	}
	if (action === 'start') command('/usr/bin/docker', [...compose, 'up', '--detach', '--no-deps', '--wait', '--wait-timeout', String(waitTimeoutSeconds), ...runtime.gpuServices]);
	if (action === 'stop') command('/usr/bin/docker', [...compose, 'stop', ...runtime.gpuServices]);
	const output = command('/usr/bin/docker', [...compose, 'ps', '--status', 'running', '--services', ...runtime.gpuServices], '');
	const running = new Set(typeof output === 'string' ? output.trim().split(/\s+/u).filter(Boolean) : []);
	return { role, action, running: runtime.gpuServices.filter((service) => running.has(service)), ready: runtime.gpuServices.every((service) => running.has(service)) };
}

function resetUnacceptedComponentState(componentId: string) {
	if (existsSync(`${paths.managerState}/current-receipt.json`) || existsSync(`${paths.managerState}/active-components.json`)) throw new Error('Accepted component state cannot be reset by bootstrap recovery.');
	const root = resolve(paths.components), target = resolve(root, componentId);
	if (!target.startsWith(`${root}${sep}`)) throw new Error('Component state reset escaped the managed state root.');
	rmSync(target, { recursive: true, force: true });
}

function ensureAiModeCredentials(command: CommandRunner) {
	const root = '/etc/treeseed/credentials', key = `${root}/ai-mode-client.key`, certificate = `${root}/ai-mode-client.crt`, ca = `${root}/ai-mode-ca.crt`;
	if (!existsSync(key) || !existsSync(certificate) || !existsSync(ca)) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const enrollment = enrollClient('client-ai-lab-mode', command);
		writeFileSync(key, enrollment.privateKey, { mode: 0o600 });
		writeFileSync(certificate, enrollment.certificate, { mode: 0o600 });
		writeFileSync(ca, enrollment.certificateAuthority, { mode: 0o644 });
	}
	return { clientCommonName: 'client-ai-lab-mode', key, certificate, certificateAuthority: ca };
}

const r2CredentialIds = ['cloudflare-r2-account-id', 'cloudflare-r2-management-token', 'cloudflare-r2-bucket-name', 'cloudflare-r2-access-key-id', 'cloudflare-r2-secret-access-key'] as const;
const storageSafe = (value: string) => value.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase();
function r2StorageStatus(teamId: string) {
	const metadata = `${paths.managerState}/storage/cloudflare-r2/teams/${storageSafe(teamId)}.json`;
	const binding = existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown> : null;
	return { metadataReady: Boolean(binding), childCredentialsReady: r2CredentialIds.every((id) => existsSync(`/etc/treeseed/credentials/${id}`)), metadata, binding };
}

function installR2Storage(operation: SupervisorOperation & { operation: 'storage.r2.install' }, command: CommandRunner) {
	const storage = `${paths.managerState}/storage/cloudflare-r2`, authorities = `${storage}/authorities`, teams = `${storage}/teams`, credentials = '/etc/treeseed/credentials';
	mkdirSync(authorities, { recursive: true, mode: 0o700 }); mkdirSync(teams, { recursive: true, mode: 0o700 }); mkdirSync(credentials, { recursive: true, mode: 0o700 });
	writeFileSync(`${authorities}/${operation.accountId}.token`, operation.bootstrapToken, { mode: 0o600 });
	const values: Record<(typeof r2CredentialIds)[number], string> = {
		'cloudflare-r2-account-id': operation.accountId, 'cloudflare-r2-management-token': operation.managementToken,
		'cloudflare-r2-bucket-name': operation.bucket, 'cloudflare-r2-access-key-id': operation.accessKeyId,
		'cloudflare-r2-secret-access-key': operation.secretAccessKey,
	};
	for (const [id, secret] of Object.entries(values)) writeFileSync(`${credentials}/${id}`, secret, { mode: 0o600 });
	atomicJson(`${teams}/${storageSafe(operation.teamId)}.json`, { schemaVersion: 'treeseed.host-storage-binding/v1', backend: 'cloudflare-r2', teamId: operation.teamId,
		accountId: operation.accountId, bucket: operation.bucket, tokens: { privacy: operation.privacyTokenId, publisher: operation.publisherTokenId }, updatedAt: new Date().toISOString() }, 0o600);
	command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', storage]);
	return r2StorageStatus(operation.teamId);
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
			try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', String(operation.waitTimeoutSeconds), ...(operation.services ?? [])]); }
			catch (error) { restoreSecrets(operation.componentId); throw error; }
			break;
		case 'compose.stop': try {
			if (composeProjectContainerIds(operation.projectName, command).length === 0) break;
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
		case 'ai.gpu.gate': return aiGate(operation.role, operation.action, operation.files, command);
		case 'ai.gpu.workload': return aiWorkload(operation.role, operation.action, operation.files, operation.waitTimeoutSeconds, command);
		case 'ai.mode.credentials.ensure': return ensureAiModeCredentials(command);
		case 'storage.r2.status': return r2StorageStatus(operation.teamId);
		case 'storage.r2.install': return installR2Storage(operation, command);
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
