import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { componentCredential } from '../src/core/component-credential.js';
import { assertEmptyPersistentPlaceholder, ephemeralComposeOverlay, usesSealedComponentCredentials } from '../src/supervisor/component-ephemeral.js';
import { readFileSync, type Stats } from 'node:fs';
import { managedRuntimeInputEnvironment } from '../src/manager/runtime-inputs.js';
import { renderComponentEnvironment } from '../src/supervisor/component.js';
import { decodeComponentCredential } from '../src/supervisor/component-sealed.js';
import { component, host } from './fixtures.js';

describe('shared OS component credential contract', () => {
	it('accepts the Debian empty placeholder but never existing plaintext or unsafe files', () => {
		const packaging = readFileSync(new URL('../scripts/package-deb.ts', import.meta.url), 'utf8');
		expect(packaging).toContain('install -o root -g treeseed-manager -m 0640 /dev/null');
		const metadata = { uid: 0, size: 0, mode: 0o100640, isFile: () => true, isSymbolicLink: () => false };
		const inspect = (value: Partial<Stats>) => () => ({ ...metadata, ...value });
		expect(() => assertEmptyPersistentPlaceholder('/fixture/environment', inspect({}))).not.toThrow();
		for (const value of [{ size: 1 }, { uid: 1000 }, { mode: 0o100644 }, { mode: 0o100660 }, { isFile: () => false }, { isSymbolicLink: () => true }])
			expect(() => assertEmptyPersistentPlaceholder('/fixture/environment', inspect(value))).toThrow(/explicit custody migration/);
		expect(() => assertEmptyPersistentPlaceholder('/fixture/missing', () => { throw Object.assign(new Error(), { code: 'ENOENT' }); })).not.toThrow();
		expect(() => assertEmptyPersistentPlaceholder('/fixture/denied', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).toThrow('denied');
	});
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
	it('resolves inherited environment blocks in the published AI Compose layout', () => {
		const source = `x-environment: &environment\n  env_file: /etc/treeseed/components/ai-inference/environment\nx-security: &security\n  security_opt: [no-new-privileges:true]\nservices:\n  api:\n    <<: [*environment, *security]\n    image: immutable-api\n  worker:\n    <<: *environment\n    image: immutable-worker\n`;
		const overlay = ephemeralComposeOverlay('ai-inference', [source], {});
		expect(overlay.match(/env_file: !override/gu)).toHaveLength(2);
		expect(overlay.match(/\/run\/treeseed\/component-runtime\/ai-inference\/environment/gu)).toHaveLength(2);
		expect(overlay).not.toContain('image:');
		expect(overlay).not.toContain('/etc/treeseed/components/');
	});
});
