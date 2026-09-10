import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceCatalog, sourceWorkspaceId } from '../src/sandbox/workspace-catalog.js';
import type { SourceWorkspaceAuthorization, SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

const source: SourceWorkspaceKey = { controlPlaneId: 'control-plane', teamId: 'team', projectId: 'project', repositoryId: 'repo',
	commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' };
const now = new Date('2026-01-01T00:01:00Z');
const authority = (key = source): SourceWorkspaceAuthorization => ({ schemaVersion: 'treeseed.source-workspace-authorization/v1',
	id: 'authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1, source: key, mode: 'work', publication: 'denied',
	credentialBindingId: 'binding', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:10:00Z' });
function publish(catalog: WorkspaceCatalog, key = source, parent: string | null = null) {
	const id = catalog.ensure(key).id, { jobId } = catalog.claimBuild(id, parent);
	catalog.publish(id, jobId, { digest: `sha256:${'c'.repeat(64)}`, bytes: 4096, commit: key.commit,
		clean: true, filesystemVerified: true, builderStopped: true });
	return id;
}

describe('durable source workspace catalog', () => {
	it('denies publication for analysis and requires live explicit work authority', () => {
		const catalog = new WorkspaceCatalog(':memory:');
		try {
			publish(catalog);
			const analysis = catalog.lease({ ...authority(), mode: 'analysis' }, now);
			expect(() => catalog.assertCandidateAuthority(analysis.id, 'authority', now)).toThrow('publication');
			const work = catalog.lease({ ...authority(), assignmentId: 'work', publication: 'candidate-only' }, now);
			expect(() => catalog.assertCandidateAuthority(work.id, 'authority', now)).not.toThrow();
			expect(() => catalog.assertCandidateAuthority(work.id, 'different', now)).toThrow('publication');
			expect(() => catalog.assertCandidateAuthority(work.id, 'authority', new Date('2026-01-01T00:11:00Z'))).toThrow('publication');
		} finally { catalog.close(); }
	});
	it('renews without privilege expansion and cannot resurrect expired leases', () => {
		const catalog = new WorkspaceCatalog(':memory:');
		try {
			publish(catalog); const lease = catalog.lease(authority(), now);
			const renewed = { ...authority(), id: 'renewed', expiresAt: '2026-01-01T00:20:00Z' };
			expect(() => catalog.renew(lease.id, { ...renewed, publication: 'candidate-only' }, now)).toThrow('authority');
			catalog.renew(lease.id, renewed, now);
			expect(catalog.lease(renewed, now).id).toBe(lease.id);
			expect(() => catalog.lease({ ...renewed, expiresAt: '2026-01-01T00:40:00Z' }, new Date('2026-01-01T00:21:00Z'))).toThrow('replay');
			expect(() => catalog.renew(lease.id, { ...renewed, expiresAt: '2026-01-01T00:40:00Z' }, new Date('2026-01-01T00:21:00Z'))).toThrow('expired');
			catalog.quarantineExpired(new Date('2026-01-01T00:21:00Z'));
			catalog.recordDurableResult(lease.id, 'recovered-failure-receipt');
			catalog.release(lease.id, true);
			expect(catalog.claimDeletion(sourceWorkspaceId(source))).toBe(true);
		} finally { catalog.close(); }
	});
	it('keys caches by security domain as well as source revision', () => {
		for (const field of ['controlPlaneId', 'teamId', 'projectId', 'repositoryId'] as const) {
			expect(sourceWorkspaceId({ ...source, [field]: 'other' })).not.toBe(sourceWorkspaceId(source));
		}
	});
	it('never leases missing, building or incorrectly verified images', () => {
		const catalog = new WorkspaceCatalog(':memory:');
		try {
			const id = catalog.ensure(source).id;
			expect(() => catalog.lease(authority(), now)).toThrow('READY');
			const job = catalog.claimBuild(id);
			expect(() => catalog.claimBuild(id)).toThrow('owned');
			expect(() => catalog.publish(id, job.jobId, { digest: `sha256:${'c'.repeat(64)}`, bytes: 4096,
				commit: 'b'.repeat(40), clean: true, filesystemVerified: true, builderStopped: true })).toThrow('commit');
			expect(() => catalog.lease(authority(), now)).toThrow('READY');
		} finally { catalog.close(); }
	});
	it('retains dependencies, active leases and expired-but-not-destroyed VMs', () => {
		const catalog = new WorkspaceCatalog(':memory:');
		try {
			const parent = publish(catalog), next = { ...source, commit: 'b'.repeat(40) }, child = publish(catalog, next, parent);
			expect(catalog.claimDeletion(parent)).toBe(false);
			catalog.lease(authority(next), now);
			expect(catalog.claimDeletion(child)).toBe(false);
			expect(catalog.quarantineExpired(new Date('2026-01-01T00:11:00Z'))).toBe(1);
			expect(catalog.claimDeletion(child)).toBe(false);
		} finally { catalog.close(); }
	});
	it('requires durable results and verified teardown before storage can be collected', () => {
		const catalog = new WorkspaceCatalog(':memory:');
		try {
			const id = publish(catalog), lease = catalog.lease(authority(), now);
			expect(catalog.lease(authority(), now)).toEqual({ ...lease, noop: true });
			expect(() => catalog.release(lease.id, true)).toThrow('durable');
			catalog.recordDurableResult(lease.id, 'durable-result');
			expect(() => catalog.release(lease.id, false)).toThrow('teardown');
			catalog.release(lease.id, true);
			expect(catalog.claimDeletion(id)).toBe(true);
			catalog.finishDeletion(id); expect(catalog.image(id)).toBeUndefined();
		} finally { catalog.close(); }
	});
	it('rejects cross-domain parents and forces flattening at the bounded depth', () => {
		const catalog = new WorkspaceCatalog(':memory:', 1);
		try {
			const parent = publish(catalog), child = publish(catalog, { ...source, commit: 'b'.repeat(40) }, parent);
			const other = catalog.ensure({ ...source, teamId: 'other' }).id;
			expect(() => catalog.claimBuild(other, parent)).toThrow('security domain');
			const next = catalog.ensure({ ...source, commit: 'd'.repeat(40) }).id;
			expect(() => catalog.claimBuild(next, child)).toThrow('flattened');
		} finally { catalog.close(); }
	});
	it('recovers metadata after restart without resetting active ownership', () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-workspace-catalog-')), path = join(directory, 'catalog.db');
		try {
			let catalog = new WorkspaceCatalog(path); const id = publish(catalog); const lease = catalog.lease(authority(), now); catalog.close();
			catalog = new WorkspaceCatalog(path);
			try { expect(catalog.lease(authority(), now).id).toBe(lease.id); expect(catalog.claimDeletion(id)).toBe(false); }
			finally { catalog.close(); }
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
