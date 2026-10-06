import { describe, expect, it } from 'vitest';
import { nativePublicationFixture } from './publication-native-fixture.js';

describe('real source controller SQLite candidate verifier and publication job boundary (integration)', () => {
	it('retains exact verified Git content and one publication through concurrent drains without changing SQL custody', async () => {
		const f = await nativePublicationFixture();
		try {
			const before = f.snapshot(), input = structuredClone(f.f.response), job = f.start();
			await Promise.all([job.drain(), job.drain()]); await job.drain();
			expect(job.status()).toEqual({ state: 'published', reference: { kind: 'git', repository: 'treeseed-ai/sdk', commit: f.commit, branch: input.authorization.publicationRef } });
			expect(f.refs()).toBe(`${f.commit} refs/heads/${input.authorization.publicationRef}`);
			expect(f.git(f.remote, 'show', `${f.commit}:code.ts`)).toBe('export const value = 2;');
			expect(f.git(f.remote, 'show', `${f.base}:code.ts`)).toBe('export const value = 1;');
			expect(f.counts()).toEqual({ verified: 1, published: 1 }); expect(f.snapshot()).toEqual(before); expect(f.f.response).toEqual(input);
		} finally { await f.close(); }
	});
	it('retains work and denies changed branch authority after real Git verification without writing foreign refs', async () => {
		const outcomes: Array<{ state: string; refs: string }> = [];
		for (const branch of ['main', 'simulation/foreign/workday/assignment']) {
			const f = await nativePublicationFixture();
			try {
				const before = f.snapshot(), response = structuredClone(f.f.response); response.authorization.publicationRef = branch; f.set(response);
				const job = f.start(); await job.drain();
				expect(f.counts().verified).toBe(1); expect(f.snapshot()).toEqual(before);
				outcomes.push({ state: job.status().state, refs: f.refs() });
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual([{ state: 'retained', refs: '' }, { state: 'retained', refs: '' }]);
	});
	it('denies expired and future publication envelopes after native verification while retaining the original lease', async () => {
		const outcomes: Array<{ state: string; refs: string }> = [];
		for (const mode of ['expired', 'future']) {
			const f = await nativePublicationFixture();
			try {
				const before = f.snapshot(), response = structuredClone(f.f.response), now = +f.f.now;
				Object.assign(response.authorization, mode === 'expired'
					? { issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() }
					: { issuedAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + 60_001).toISOString() });
				f.set(response); const job = f.start(); await job.drain();
				expect(f.counts().verified).toBe(1); expect(f.snapshot()).toEqual(before);
				outcomes.push({ state: job.status().state, refs: f.refs() });
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual([{ state: 'retained', refs: '' }, { state: 'retained', refs: '' }]);
	});
	it('retains real verified work on publication interruption and allows exact retry without another lease or guessed teardown', async () => {
		const f = await nativePublicationFixture();
		try {
			const before = f.snapshot(); const running = f.start(false); await running.drain();
			expect(running.status().state).toBe('retained'); expect(f.counts()).toEqual({ verified: 0, published: 0 });
			f.interrupt(true); const failed = f.start(); await failed.drain();
			expect(failed.status()).toMatchObject({ state: 'retained', failure: 'isolated publication interruption' });
			expect(f.refs()).toBe(''); expect(f.snapshot()).toEqual(before);
			f.interrupt(false); const retry = f.start(); await retry.drain();
			expect(retry.status().state).toBe('published'); expect(f.counts()).toEqual({ verified: 2, published: 1 });
			expect(f.snapshot()).toEqual(before); expect(f.refs()).toBe(`${f.commit} refs/heads/${f.f.response.authorization.publicationRef}`);
		} finally { await f.close(); }
	});
});
