import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { componentCredential } from '../src/core/component-credential.js';
import { ephemeralComposeOverlay, usesSealedComponentCredentials } from '../src/supervisor/component-ephemeral.js';
import { managedRuntimeInputEnvironment } from '../src/manager/runtime-inputs.js';
import { renderComponentEnvironment } from '../src/supervisor/component.js';
import { decodeComponentCredential } from '../src/supervisor/component-sealed.js';
import { component, host } from './fixtures.js';

describe('shared OS component credential contract', () => {
	it('binds the decrypt name, erases plaintext buffers, and sanitizes failures', () => {
		const plaintext = Buffer.from('fixture-only');
		expect(decodeComponentCredential('database', 'database', Buffer.from('sealed'), (name, bytes) => {
			expect(name).toBe('database'); expect(bytes.toString()).toBe('sealed'); return plaintext;
		})).toBe('fixture-only');
		expect(plaintext.every(byte => byte === 0)).toBe(true);
		expect(() => decodeComponentCredential('database', 'database', Buffer.alloc(1), () => { throw new Error('sensitive subprocess output'); }))
			.toThrow('OS credential database is unavailable or unsafe.');
		expect(() => decodeComponentCredential('database', 'database', Buffer.alloc(1), () => Buffer.from('bad\0value'))).toThrow(/unavailable or unsafe/);
	});
	it('accepts sealed records only at the exact declared credential path', () => {
		const configuration = host();
		configuration.secrets.database = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/database.cred' };
		expect(componentCredential(configuration, 'database').name).toBe('database');
		configuration.secrets.database.reference = '/etc/treeseed/credentials/another.cred';
		expect(() => componentCredential(configuration, 'database')).toThrow(/declared custody/);
		expect(() => componentCredential(configuration, '../database')).toThrow(/fixed custody/);
	});

	it('validates sealed environment and aliased files without reading or returning their values', () => {
		const configuration = host(), release = component('ai-inference', 'development', 'a');
		configuration.components['ai-inference'] = { ...configuration.components.api!, configuration: { secretEnvironment: { DATABASE_URL: 'database' } } };
		configuration.secrets.database = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/database.cred' };
		configuration.secrets.signing = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/ai-signing.cred' };
		release.runtime.configuration = { environment: [], files: [], secretEnvironment: [{ name: 'DATABASE_URL', required: true }],
			secretFiles: [{ id: 'signing', path: '/etc/treeseed/credentials/ai-signing', required: true }] };
		expect(managedRuntimeInputEnvironment(configuration, release)).toEqual({});
		expect(usesSealedComponentCredentials(configuration, 'ai-inference', ['signing'])).toBe(true);
		const rendered = renderComponentEnvironment(configuration, 'ai-inference', {}, path => {
			expect(path).toBe('/etc/treeseed/credentials/database.cred'); return 'fixture-secret';
		});
		expect(rendered).toContain('DATABASE_URL="fixture-secret"');
	});

	it('rebinds only declared environment and secret inputs without altering service implementation', () => {
		const source = YAML.stringify({ services: { api: { image: 'immutable-image', env_file: ['/etc/treeseed/components/ai-inference/environment', '/package/defaults'], ports: ['443:443'] }, worker: { image: 'worker' } } });
		const overlay = ephemeralComposeOverlay('ai-inference', [source], { signing: { file: '/run/treeseed/component-runtime/ai-inference/secret-signing' } });
		expect(overlay).toContain('env_file: !override');
		expect(overlay).toContain('/run/treeseed/component-runtime/ai-inference/environment');
		expect(overlay).toContain('/package/defaults');
		expect(overlay).not.toContain('image:');
		expect(overlay).not.toContain('ports:');
		expect(overlay).not.toContain('worker:');
		expect(() => ephemeralComposeOverlay('ai-inference', [source], { signing: { file: '/run/treeseed/component-runtime/ai-training/secret-signing' } })).toThrow(/binding/);
	});
});
