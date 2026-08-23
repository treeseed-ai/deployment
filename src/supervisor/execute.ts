import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { generateEdgeCertificate } from '../edge/certificates.js';

export type CommandRunner = (executable: string, arguments_: readonly string[]) => void;
const run: CommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } }); };

function bundledComposeFiles(files: readonly string[]) {
	return files.flatMap((file) => {
		const absolute = resolve(paths.bundles, file), root = resolve(paths.bundles);
		if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Compose file is outside the packaged component root.');
		return ['--file', absolute];
	});
}

export function executeSupervisorOperation(input: unknown, command: CommandRunner = run) {
	if (process.getuid?.() !== 0 && command === run) throw new Error('TreeSeed supervisor must run as root.');
	const operation: SupervisorOperation = supervisorOperationSchema.parse(input);
	switch (operation.operation) {
		case 'apt.install':
			atomicJson(`${paths.managerState}/pending-packages.json`, operation, 0o600);
			command('/usr/bin/systemctl', ['start', 'treeseed-manager-apt-helper.service']);
			break;
		case 'compose.activate': command('/usr/bin/docker', ['compose', ...bundledComposeFiles(operation.files), '--project-name', operation.projectName, 'up', '--detach', '--remove-orphans', '--wait']); break;
		case 'compose.stop': command('/usr/bin/docker', ['compose', ...bundledComposeFiles(operation.files), '--project-name', operation.projectName, 'stop']); break;
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
		case 'recovery.restore': command('/usr/lib/treeseed/manager/bin/restore-generation', [String(operation.generation)]); break;
	}
}
