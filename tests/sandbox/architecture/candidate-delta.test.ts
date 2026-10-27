import { expect, it } from 'vitest';
import { nativePublicationFixture } from './publication-native-fixture.js';

it('publishes a small real Git contribution below its unchanged ceiling despite substantial pre-base project history', async () => {
	const f = await nativePublicationFixture(131_072);
	try {
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
