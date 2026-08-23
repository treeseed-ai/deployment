import { readFileSync } from 'node:fs';
import { hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';
import { paths } from './paths.js';

export function loadHostConfiguration(path = paths.configuration): HostConfiguration {
	return hostConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function assertNewGeneration(current: HostConfiguration | undefined, candidate: HostConfiguration) {
	if (!current) return;
	if (current.configurationId !== candidate.configurationId) throw new Error('A different configurationId requires an explicit adoption operation.');
	if (candidate.generation <= current.generation) throw new Error('Host configuration generation must increase monotonically.');
}
