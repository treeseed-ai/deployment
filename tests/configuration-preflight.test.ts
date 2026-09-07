import { expect, it } from 'vitest';
import { host, component } from './fixtures.js';
import { assertConfigurationRuntimeInputs } from '../src/manager/configuration-preflight.js';

it('rejects inputs introduced by an unavailable runtime before configuration replacement', () => {
	const configuration = host(), release = component('ai-inference', 'development', 'd');
	release.runtime.configuration = { environment: [{ name: 'AI_TEAM_ID', source: 'configuration', required: false }], secretEnvironment: [], secretFiles: [], files: [] };
	configuration.components['ai-inference'] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: { environment: { AI_STORAGE_URL: 'https://api.example.test/v1/internal/ai/storage/credentials' } } } as any;
	expect(() => assertConfigurationRuntimeInputs(configuration, [release])).toThrow(/undeclared inputs/u);
	release.runtime.configuration.environment.push({ name: 'AI_STORAGE_URL', source: 'configuration', required: false });
	expect(() => assertConfigurationRuntimeInputs(configuration, [release])).not.toThrow();
});
