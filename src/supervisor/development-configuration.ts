import { atomicJson } from '../core/files.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { paths } from '../core/paths.js';
import { reconcileDevelopmentConfiguration } from '../core/development-configuration.js';
import type { CommandRunner } from './execute.js';

export function ensureDevelopmentConfiguration(command: CommandRunner, path: string = paths.configuration) {
	const result = reconcileDevelopmentConfiguration(loadHostConfiguration(path));
	if (!result.changed) return { changed: false, generation: result.configuration.generation };
	atomicJson(path, result.configuration, 0o640);
	command('/usr/bin/chown', ['root:treeseed-manager', path]);
	return { changed: true, generation: result.configuration.generation };
}
