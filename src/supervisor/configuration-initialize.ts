import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';
import type { SupervisorOperation } from './protocol.js';

type CommandRunner = (executable: string, arguments_: readonly string[], input?: string) => unknown;

export function initializeHostConfiguration(configuration: SupervisorOperation & { operation: 'configuration.initialize' }, command: CommandRunner,
	configurationPath: string = paths.configuration, marker: string = `${paths.managerState}/bootstrap-status.json`, credentialRoot = '/etc/treeseed/credentials') {
	if (existsSync(configurationPath)) throw new Error('Host configuration initialization requires an unconfigured foundation.');
	const oneTimeCredentials = configuration.oneTimeCredentials ?? {};
	if (Object.keys(oneTimeCredentials).length > 4) throw new Error('Host configuration initialization accepts at most four one-time credentials.');
	if (Object.keys(oneTimeCredentials).some((id) => configuration.configuration.secrets[id]?.reference !== `/etc/treeseed/credentials/${id}`)) {
		throw new Error('Each one-time credential must be referenced by the initialized host configuration.');
	}
	const writtenCredentials: string[] = [];
	try {
		if (Object.keys(oneTimeCredentials).length) mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
		for (const [id, value] of Object.entries(oneTimeCredentials)) {
			const path = `${credentialRoot}/${id}`;
			writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
			writtenCredentials.push(path);
		}
		atomicJson(configurationPath, configuration.configuration, 0o640);
	} catch (error) {
		for (const path of writtenCredentials) try { unlinkSync(path); } catch { /* preserve the initialization failure */ }
		throw error;
	}
	command('/usr/bin/chown', ['root:treeseed-manager', configurationPath]);
	atomicJson(marker, { complete: true, foundationReady: true, initializationRequired: false, installerCredentialsRetained: false }, 0o640);
	command('/usr/bin/chown', ['treeseed-manager:treeseed-manager', marker]);
	return { initialized: true, configurationId: configuration.configuration.configurationId, generation: configuration.configuration.generation };
}
