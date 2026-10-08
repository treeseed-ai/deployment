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
	it('inspects every fresh backup writer inventory in one batch and retains later writer exclusion', () => {
		const ids = ['a'.repeat(64), 'b'.repeat(64)], calls: string[][] = [];
		let writer = false;
		const rows = () => [[{ Source: '/opt/unrelated', RW: true }], [{ Source: `/${root}`, RW: writer }]];
		const capture = (args: string[]) => {
			calls.push([...args]);
			return args[0] === 'ps' ? ids.join('\n') : rows().map(row => JSON.stringify(row)).join('\n');
		};
		const original = JSON.stringify(ids);
		expect(() => assertNoBackupWriters([root], capture)).not.toThrow();
		writer = true;
		expect(() => assertNoBackupWriters([root], capture)).toThrow(/Backup blocked/);
		expect(calls.filter(args => args[0] === 'ps')).toHaveLength(2);
		expect(calls.filter(args => args[0] === 'inspect')).toEqual([
			['inspect', '--format', '{{json .Mounts}}', ...ids], ['inspect', '--format', '{{json .Mounts}}', ...ids],
		]);
		expect(JSON.stringify(ids)).toBe(original);
	});
	it('denies duplicated invalid missing extra and malformed batch writer observations without changing inputs', () => {
		const ids = ['a'.repeat(64), 'b'.repeat(64)], safe = JSON.stringify([{ Source: '/opt/unrelated', RW: false }]);
		for (const supplied of [safe, `${safe}\n${safe}\n${safe}`, `${safe}\nnot-json`, `${safe}\nnull`,
			`${safe}\n{}`, `${safe}\n[null]`, `${safe}\n[{"Source":"relative","RW":true}]`]) {
			const calls: string[][] = [], original = supplied;
			expect(() => assertNoBackupWriters([root], args => {
				calls.push([...args]); return args[0] === 'ps' ? ids.join('\n') : supplied;
			})).toThrow();
			expect(calls.filter(args => args[0] === 'inspect')).toHaveLength(1);
			expect(supplied).toBe(original);
		}
		for (const inventory of [`${ids[0]}\n${ids[0]}`, `${ids[0]}\ninvalid-id`]) {
			const calls: string[][] = [];
			expect(() => assertNoBackupWriters([root], args => { calls.push([...args]); return inventory; })).toThrow();
			expect(calls).toEqual([['ps', '--quiet']]);
		}
		const calls: string[][] = [];
		expect(() => assertNoBackupWriters([root], args => { calls.push([...args]); return ''; })).not.toThrow();
		expect(calls).toEqual([['ps', '--quiet']]);
	});
});
