import { expect, it } from 'vitest';
import { nativePublicationFixture } from './publication-native-fixture.js';
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifySourceCandidate } from '../../../src/sandbox/workspace-candidate-guest.js';
import { publishVerifiedSourceBranch } from '../../../src/sandbox/source-branch-publication.js';

it('publishes a small real Git contribution below its unchanged ceiling despite substantial pre-base project history', async () => {
	const f = await nativePublicationFixture(131_072);
	try {
		expect((await stat(f.baseBundlePath)).size).toBeGreaterThan(4096);
		const before = f.snapshot(), job = f.start(true, 4096);
		await job.drain();
		expect(job.status()).toMatchObject({ state: 'published', reference: { commit: f.commit } });
		expect(f.git(f.remote, 'show', `${f.commit}:code.ts`)).toBe('export const value = 2;');
		expect(f.git(f.remote, 'show', `${f.base}:code.ts`)).toBe('export const value = 1;');
		expect(f.git(f.remote, 'fsck', '--strict', '--no-reflogs')).not.toContain('missing');
		expect(f.snapshot()).toEqual(before);
		const verified = f.journals.find(value => value.state === 'verified')!.verification as { bytes: number };
		expect(verified.bytes).toBeLessThanOrEqual(4096);
	} finally { await f.close(); }
});

it('retains the original ceiling for genuinely oversized new source rather than charging it to authorized history', async () => {
	const f = await nativePublicationFixture();
	try {
		await writeFile(join(f.root, 'new-asset.bin'), randomBytes(8192));
		f.git(f.root, 'add', '.'); f.git(f.root, 'commit', '--quiet', '-m', 'large contribution');
		await expect(verifySourceCandidate({ root: f.root, baseCommit: f.base,
			commit: f.git(f.root, 'rev-parse', 'HEAD'), maxBytes: 4096,
			output: join(f.directory, 'oversized.bundle'), scratch: join(f.directory, 'scratch') })).rejects.toThrow('output limit');
		expect(f.refs()).toBe('');
	} finally { await f.close(); }
});

it('denies missing corrupt and foreign publication prerequisites without changing the retained product or local target', async () => {
	const f = await nativePublicationFixture();
	try {
		const job = f.start(); await job.drain(); expect(job.status().state).toBe('published');
		const refs = f.refs(), bundlePath = join(f.directory, 'candidate-0.bundle'), bytes = await readFile(bundlePath);
		const corrupt = join(f.directory, 'corrupt-base.bundle'); await writeFile(corrupt, 'not a Git bundle');
		for (const baseBundlePath of [join(f.directory, 'missing-base.bundle'), corrupt]) {
			await expect(publishVerifiedSourceBranch({ assignmentId: f.f.owner.assignmentId, attempt: 1,
				commit: f.commit, bundlePath, baseBundlePath, response: f.f.response })).rejects.toThrow();
			expect(f.refs()).toBe(refs); expect(await readFile(bundlePath)).toEqual(bytes);
		}
		const response = structuredClone(f.f.response); response.authorization.source.commit = 'a'.repeat(40);
		await expect(publishVerifiedSourceBranch({ assignmentId: f.f.owner.assignmentId, attempt: 1,
			commit: f.commit, bundlePath, baseBundlePath: f.baseBundlePath, response })).rejects.toThrow();
		expect(f.refs()).toBe(refs); expect(await readFile(bundlePath)).toEqual(bytes);
	} finally { await f.close(); }
});
