import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { generateEdgeCertificate } from '../edge/certificates.js';
import { assertNewGeneration, loadHostConfiguration } from '../core/configuration.js';
import { enrollClient } from './pki.js';
import { configureComponent } from './component.js';
import { createGenerationBackup, restoreGenerationBackup } from './backup.js';

export type CommandRunner = (executable: string, arguments_: readonly string[]) => void;
const run: CommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } }); };

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

function ensureNetwork(name: 'treeseed-platform' | 'treeseed-edge', command: CommandRunner) {
	try { command('/usr/bin/docker', ['network', 'inspect', name]); }
	catch { command('/usr/bin/docker', ['network', 'create', '--driver', 'bridge', '--label', 'org.treeseed.manager=true', name]); }
}

export function executeSupervisorOperation(input: unknown, command: CommandRunner = run) {
	if (process.getuid?.() !== 0 && command === run) throw new Error('TreeSeed supervisor must run as root.');
	const operation: SupervisorOperation = supervisorOperationSchema.parse(input);
	switch (operation.operation) {
		case 'apt.refresh':
		case 'apt.install':
			atomicJson(`${paths.managerState}/pending-packages.json`, operation, 0o600);
			command('/usr/bin/systemctl', ['start', 'treeseed-manager-apt-helper.service']);
			if (operation.operation === 'apt.refresh' && existsSync(`${paths.managerState}/last-apt-result.json`)) return JSON.parse(readFileSync(`${paths.managerState}/last-apt-result.json`, 'utf8')) as unknown;
			break;
		case 'component.configure': configureComponent(operation.componentId); break;
		case 'compose.activate':
			ensureNetwork('treeseed-platform', command);
			ensureNetwork('treeseed-edge', command);
			command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', String(operation.waitTimeoutSeconds)]);
			break;
		case 'compose.stop': command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'stop']); break;
		case 'systemd.control': command('/usr/bin/systemctl', [operation.action, operation.unit]); break;
		case 'edge.apply': {
			const target = `${paths.edge}/Caddyfile`, temporary = `${target}.new`;
			mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
			writeFileSync(temporary, operation.caddyfile, { mode: 0o640 });
			generateEdgeCertificate(operation.aliases, command);
			command('/usr/bin/docker', ['compose', '--file', '/usr/share/treeseed/edge/compose.yml', 'run', '--rm', '--no-deps', 'caddy', 'caddy', 'validate', '--config', temporary, '--adapter', 'caddyfile']);
			renameSync(temporary, target);
			command('/usr/bin/systemctl', ['reload', 'treeseed-edge.service']);
			break;
		}
		case 'backup.create': return createGenerationBackup(operation.generation, command);
		case 'recovery.restore': return restoreGenerationBackup(operation.generation, command);
		case 'manager.restart': command('/usr/bin/systemctl', ['--no-block', 'restart', 'treeseed-manager-supervisor.service', 'treeseed-manager-api.service']); break;
		case 'configuration.replace': {
			const current = loadHostConfiguration();
			assertNewGeneration(current, operation.configuration);
			atomicJson(paths.configuration, operation.configuration, 0o640);
			break;
		}
		case 'pki.enroll': return enrollClient(operation.clientId, command);
	}
}
