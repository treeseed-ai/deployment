import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicationFixture } from './publication-fixture.js';

describe('attached source publication authority boundary (UNIT)', () => {
	it('reads an existing exact simulation ref without reinitializing its repository and denies a conflicting ref without mutation', async () => {
		const f = await publicationFixture(), root = await mkdtemp(join(tmpdir(), 'publication-replay-unit-'));
		vi.resetModules(); vi.doMock('../../../src/sandbox/workspace-block-store.js', () => ({workspaceStorageRoot:root}));
		const calls: {repository:string; args:string[]}[] = [], commit = 'b'.repeat(40);
		let observed = commit;
		vi.doMock('../../../src/sandbox/source-git-transport.js', () => ({ runSourceGit: async (repository:string, args:string[]) => {
			calls.push({repository,args:[...args]});
			if (args[0] === 'rev-parse') return commit;
			if (args[0] === 'for-each-ref') return observed;
			return '';
		} }));
		try {
			const {publishVerifiedSourceBranch} = await import('../../../src/sandbox/source-branch-publication.js');
			const {simulationSourceRepository} = await import('../../../src/sandbox/simulation-source-repository.js');
			const repository = simulationSourceRepository(root,f.response.authorization.source), config = Buffer.from('original native configuration\n');
			await mkdir(repository,{recursive:true}); await writeFile(join(repository,'config'),config);
			const input = {assignmentId:'assignment',attempt:1,commit,bundlePath:join(root,'supplied.bundle'),response:f.response}, held=structuredClone(input);
			for (const conflicting of [false,true]) {
				calls.length=0; observed=conflicting?'c'.repeat(40):commit;
				if (conflicting) await expect(publishVerifiedSourceBranch(input)).rejects.toThrow('another commit');
				else expect(await publishVerifiedSourceBranch(input)).toEqual({kind:'git',repository:'treeseed-ai/sdk',commit,branch:f.response.authorization.publicationRef});
				expect(calls.filter(call=>call.repository===repository)).toEqual([{repository,args:['for-each-ref','--format=%(objectname)',`refs/heads/${f.response.authorization.publicationRef}`]},
					...(!conflicting ? [{repository,args:['rev-parse','--verify',`refs/heads/${f.response.authorization.publicationRef}^{commit}`]}] : [])]);
				expect(await readFile(join(repository,'config'))).toEqual(config);
				expect(await readdir(join(root,'publications'))).toEqual([]); expect(input).toEqual(held);
			}
		} finally {
			vi.doUnmock('../../../src/sandbox/source-git-transport.js'); vi.doUnmock('../../../src/sandbox/workspace-block-store.js'); vi.resetModules();
			f.close(); await rm(root,{recursive:true,force:true});
		}
	});
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
