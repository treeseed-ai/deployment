import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { host } from './fixtures.js';
import { initializeHostConfiguration } from '../src/supervisor/execute.js';

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
});
