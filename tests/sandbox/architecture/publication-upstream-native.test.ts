import { expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceWorkspaceResponseSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { createSourceCredentialRecipient, openSourceCredential, sealSourceCredential } from '../../../src/security/services/source-credential-delivery.js';
import { nativePublicationFixture } from './publication-native-fixture.js';

it('publishes and replays an exact incremental contribution through upstream Git transport with its sealed authority and unchanged ceiling', async () => {
	const f = await nativePublicationFixture(131_072), upstream = join(f.directory, 'upstream.git');
	try {
		const job = f.start(true, 4096); await job.drain(); expect(job.status().state).toBe('published');
		await mkdir(upstream); f.git(upstream, 'init', '--bare', '--template=');
		const authorization = { ...f.f.response.authorization, acquisition: 'upstream-authorized' as const,
			publication: 'assignment-branch' as const, publicationRef: 'treeseed/assignments/assignment/1', credentialBindingId: 'binding' };
		const recipient = createSourceCredentialRecipient(), secret = { username: 'fixture', token: 'controlled-native-test-token' };
		const delivery = sealSourceCredential({ authorization, recipientPublicKey: recipient.publicKey, credential: secret }, f.f.now);
		const response = sourceWorkspaceResponseSchema.parse({ ...f.f.response, authorization, credential: delivery });
		let pushes = 0;
		// Only the external Git endpoint and authentication transport are controlled.
		// Native Git imports, object closure, push, exact remote read-back and replay run unchanged.
		vi.doMock('../../../src/sandbox/source-git-transport.js', async importOriginal => {
			const actual = await importOriginal<typeof import('../../../src/sandbox/source-git-transport.js')>();
			return { ...actual, runSourceGit: async (...[repository, args, credential]: Parameters<typeof actual.runSourceGit>) => {
				if (args.includes(response.repository.cloneUrl)) {
					expect(credential).toEqual(secret); if (args[0] === 'push') pushes++;
				}
				return actual.runSourceGit(repository, [...(args.includes(response.repository.cloneUrl)
					? ['-c', 'protocol.file.allow=always'] : []), ...args.map(arg => arg === response.repository.cloneUrl ? upstream : arg)]);
			} };
		});
		vi.resetModules();
		const { publishVerifiedSourceBranch } = await import('../../../src/sandbox/source-branch-publication.js');
		for (let index = 0; index < 2; index++) {
			const credential = openSourceCredential({ authorization, delivery, privateKey: recipient.privateKey }, f.f.now);
			expect(await publishVerifiedSourceBranch({ assignmentId: f.f.owner.assignmentId, attempt: 1,
				commit: f.commit, bundlePath: join(f.directory, 'candidate-0.bundle'), baseBundlePath: f.baseBundlePath,
				response, credential })).toMatchObject({ commit: f.commit, branch: authorization.publicationRef });
			expect(credential).toEqual({ username: '', token: '' });
		}
		expect(pushes).toBe(1);
		expect(f.git(upstream, 'rev-parse', `refs/heads/${authorization.publicationRef}`)).toBe(f.commit);
		expect(f.git(upstream, 'show', `${f.commit}:code.ts`)).toBe('export const value = 2;');
		expect(f.git(upstream, 'fsck', '--strict', '--no-reflogs')).not.toContain('missing');
	} finally { vi.doUnmock('../../../src/sandbox/source-git-transport.js'); vi.resetModules(); await f.close(); }
});
