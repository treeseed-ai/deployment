import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { host } from './fixtures.js';
import { initializeHostConfiguration } from '../src/supervisor/configuration-initialize.js';

describe('privileged host configuration initialization', () => {
	it('atomically installs one generation and completes the bootstrap marker', () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-initialize-'));
		try {
			const configurationPath = join(root, 'etc', 'platform.json'), marker = join(root, 'state', 'bootstrap-status.json');
			const calls: Array<[string, readonly string[]]> = [];
			const operation = { operation: 'configuration.initialize' as const, configuration: host() };
			expect(initializeHostConfiguration(operation, (executable, arguments_) => calls.push([executable, arguments_]), configurationPath, marker)).toMatchObject({ initialized: true, configurationId: 'test-host', generation: 1 });
			expect(JSON.parse(readFileSync(configurationPath, 'utf8'))).toEqual(host());
			expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ complete: true, foundationReady: true, initializationRequired: false, installerCredentialsRetained: false });
			expect(calls).toEqual([['/usr/bin/chown', ['root:treeseed-manager', configurationPath]], ['/usr/bin/chown', ['treeseed-manager:treeseed-manager', marker]]]);
			expect(() => initializeHostConfiguration(operation, () => undefined, configurationPath, marker)).toThrow(/unconfigured foundation/u);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it('writes referenced one-time credentials outside configuration and reports no values', () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-initialize-credential-'));
		try {
			const configuration = host();
			configuration.secrets['provider-registration'] = { provider: 'file', reference: '/etc/treeseed/credentials/provider-registration' };
			const configurationPath = join(root, 'etc', 'platform.json'), marker = join(root, 'state', 'bootstrap-status.json'), credentials = join(root, 'credentials');
			const result = initializeHostConfiguration({ operation: 'configuration.initialize', configuration,
				oneTimeCredentials: { 'provider-registration': 'temporary-registration-code' } }, () => undefined, configurationPath, marker, credentials);
			expect(result).toEqual({ initialized: true, configurationId: 'test-host', generation: 1 });
			expect(readFileSync(join(credentials, 'provider-registration'), 'utf8')).toBe('temporary-registration-code');
			expect(statSync(join(credentials, 'provider-registration')).mode & 0o777).toBe(0o600);
			expect(readFileSync(configurationPath, 'utf8')).not.toContain('temporary-registration-code');
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
