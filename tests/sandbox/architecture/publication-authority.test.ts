import { describe, expect, it } from 'vitest';
import { publicationFixture } from './publication-fixture.js';

describe('attached source publication authority boundary (UNIT)', () => {
	it('retains current same-branch authority and matching replay without changing the attached assignment', async () => {
		const f = await publicationFixture();
		try {
			const before = structuredClone(f.source.attachment()), response = structuredClone(f.response);
			response.authorization.id = 'fresh-publication';
			for (let index = 0; index < 2; index++) expect(f.source.publicationCredential(response)).toEqual({ response, credential: undefined });
			expect(f.source.attachment()).toEqual(before); expect(f.response.authorization.id).toBe('grant');
		} finally { f.close(); }
	});
	it('denies main and foreign simulation destinations instead of changing the sole attached assignment branch', async () => {
		const f = await publicationFixture();
		try {
			const before = structuredClone(f.source.attachment()), outcomes: boolean[] = [];
			for (const publicationRef of ['main', 'simulation/foreign/workday/assignment']) {
				const response = structuredClone(f.response); response.authorization.publicationRef = publicationRef;
				let denied = false; try { f.source.publicationCredential(response); } catch { denied = true; } outcomes.push(denied);
			}
			expect(f.source.attachment()).toEqual(before); expect(outcomes).toEqual([true, true]);
		} finally { f.close(); }
	});
	it('requires current publication authority even when simulation delivery has no sealed credential', async () => {
		const f = await publicationFixture();
		try {
			const outcomes: boolean[] = [];
			for (const clocks of [{ issuedAt: new Date(+f.now - 60_000).toISOString(), expiresAt: f.now.toISOString() },
				{ issuedAt: new Date(+f.now + 1).toISOString(), expiresAt: new Date(+f.now + 60_001).toISOString() }]) {
				const response = structuredClone(f.response); Object.assign(response.authorization, clocks);
				let denied = false; try { f.source.publicationCredential(response); } catch { denied = true; } outcomes.push(denied);
			}
			expect(outcomes).toEqual([true, true]);
		} finally { f.close(); }
	});
	it('retains foreign-owner moved-source analysis and stopped denials without releasing live catalog custody', async () => {
		const f = await publicationFixture();
		try {
			const before = structuredClone(f.catalog.collectionState());
			for (const key of ['assignmentId', 'providerId'] as const) {
				const response = structuredClone(f.response); response.authorization[key] = 'foreign';
				expect(() => f.source.publicationCredential(response)).toThrow();
			}
			for (const change of [{ commit: 'b'.repeat(40) }, { teamId: 'foreign' }, { projectId: 'foreign' }]) {
				const response = structuredClone(f.response); Object.assign(response.authorization.source, change);
				expect(() => f.source.publicationCredential(response)).toThrow();
			}
			const response = structuredClone(f.response); response.authorization.mode = 'analysis'; response.authorization.publication = 'denied';
			delete response.authorization.publicationRef;
			expect(() => f.source.publicationCredential(response)).toThrow();
			await f.source.stop(); expect(() => f.source.publicationCredential(f.response)).toThrow('stopped');
			expect(f.catalog.collectionState()).toEqual(before);
		} finally { f.close(); }
	});
});
