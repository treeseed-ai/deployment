import { describe, expect, it } from 'vitest';
import { assertNoBackupWriters } from '../src/supervisor/backup-writers.js';

describe('backup writer exclusion', () => {
	const root = 'var/lib/treeseed/components/api/postgres';
	const run = (source: string, writable = true) => (args: string[]) => args[0] === 'ps' ? 'abcdef123456' : JSON.stringify([{ Source: source, RW: writable }]);
	it('blocks exact, child and ancestor writable mounts regardless of container labels', () => {
		for (const source of [`/${root}`, `/${root}/data`, '/var/lib/treeseed', '/']) expect(() => assertNoBackupWriters([root], run(source))).toThrow(/Backup blocked/);
	});
	it('permits read-only state and unrelated sources', () => {
		expect(() => assertNoBackupWriters([root], run(`/${root}`, false))).not.toThrow();
		expect(() => assertNoBackupWriters([root], run('/opt/treeseed/source'))).not.toThrow();
	});
	it('fails closed on unavailable or malformed inventory', () => {
		expect(() => assertNoBackupWriters([root], () => { throw new Error('docker unavailable'); })).toThrow();
		expect(() => assertNoBackupWriters([root], () => 'invalid-id')).toThrow();
	});
});
