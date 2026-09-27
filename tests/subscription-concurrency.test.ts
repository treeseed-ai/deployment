import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubscriptionCredentialCustody } from '../src/sandbox/runtime.js';

const directories: string[] = [];
const credential = (refresh: string, account = 'account') => Buffer.from(JSON.stringify({ auth_mode: 'chatgpt',
	tokens: { account_id: account, access_token: 'synthetic-access', refresh_token: refresh } }));
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'subscription-concurrency-')); directories.push(directory);
	const path = join(directory, 'auth.json'), initial = credential('initial');
	await writeFile(path, initial, { mode: 0o600 });
	return { directory, path, initial, custody: new SubscriptionCredentialCustody(path) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('parallel guest subscription custody', () => {
	it('admits five independent snapshots without holding custody during guest execution', async () => {
		const { custody, initial } = await fixture();
		let active = 0, peak = 0; const releases: Array<() => void> = [];
		const guests = Array.from({ length: 5 }, async () => {
			const issued = await custody.snapshot(); expect(issued.equals(initial)).toBe(true);
			active++; peak = Math.max(peak, active);
			await new Promise<void>(resolve => releases.push(resolve));
			await custody.commit(issued, issued); active--;
		});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('Five guest snapshots were serialized behind execution')); }, 2000);
			const poll = setInterval(() => { if (releases.length === 5) { clearTimeout(timeout); clearInterval(poll); resolve(); } }, 5);
		});
		expect(peak).toBe(5); releases.forEach(release => release()); await Promise.all(guests);
	});
	it('preserves a refresh against four stale unchanged exports and permits subsequent refresh', async () => {
		const { custody, path, directory } = await fixture();
		const issued = await Promise.all(Array.from({ length: 5 }, () => custody.snapshot()));
		const rotated = credential('rotated'); await custody.commit(issued[0]!, rotated);
		await Promise.all(issued.slice(1).map(value => custody.commit(value, value)));
		expect((await readFile(path)).equals(rotated)).toBe(true);
		await custody.commit(await custody.snapshot(), credential('next'));
		expect((await stat(path)).mode & 0o777).toBe(0o600); expect(await readdir(directory)).toEqual(['auth.json']);
	});
	it('rejects ambiguous competing rotations without overwrite and recovers custody after rejection', async () => {
		const { custody, path, initial } = await fixture(); const first = credential('first');
		const outcomes = await Promise.allSettled([custody.commit(initial, first), custody.commit(initial, credential('second'))]);
		expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
		expect((await readFile(path)).equals(first)).toBe(true);
		await custody.commit(await custody.snapshot(), credential('third'));
	});
	it('rejects invalid or changed-account returns and external account replacement even for unchanged exports', async () => {
		const { custody, path, initial } = await fixture();
		await expect(custody.commit(initial, Buffer.from('{}'))).rejects.toThrow('invalid');
		await expect(custody.commit(initial, credential('other', 'other'))).rejects.toThrow('changed account');
		await writeFile(path, credential('external', 'external'));
		await expect(custody.commit(initial, initial)).rejects.toThrow('changed account');
		expect((await custody.snapshot()).equals(await readFile(path))).toBe(true);
	});
});
