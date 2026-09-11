import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { AssignmentSource, type AssignmentSourceOperations } from '../src/sandbox/assignment-source.js';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { sealSourceCredential } from '../src/security/services/source-credential-delivery.js';

const owner = { assignmentId: 'assignment', providerId: 'provider', teamId: 'team', projectId: 'project', attempt: 1 };
const now = new Date('2026-09-10T00:00:00.000Z');
const authority: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'authorization',
  providerId: owner.providerId, assignmentId: owner.assignmentId, attempt: 1,
  source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
  mode: 'analysis', publication: 'denied', credentialBindingId: 'binding', issuedAt: now.toISOString(), expiresAt: new Date(+now + 60_000).toISOString() };
const catalogs: WorkspaceCatalog[] = [];
afterEach(() => { for (const catalog of catalogs.splice(0)) catalog.close(); });
function fixture() {
  const catalog = new WorkspaceCatalog(':memory:'); catalogs.push(catalog);
  const publish = () => { const image = catalog.ensure(authority.source), job = catalog.claimBuild(image.id);
    catalog.publish(image.id, job.jobId, { digest: `sha256:${'b'.repeat(64)}`, bytes: 4096, commit: authority.source.commit, clean: true, filesystemVerified: true, builderStopped: true }); };
  const disk = { id: 'disk', directory: '/private/disk', image: '/private/disk/work.qcow2' };
  const operations: AssignmentSourceOperations = { catalog, now: () => now, build: vi.fn(async () => { publish(); }),
    createDisk: vi.fn(async () => disk), attachDisk: vi.fn(async () => ({ ...disk, device: '/dev/nbd0', unit: 'owned.service' })), journal: vi.fn(async () => undefined) };
  const controller = new AssignmentSource(owner, 1_073_741_824, operations);
  const response = (authorization = authority) => ({ authorization, repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: 'staging' },
    credential: sealSourceCredential({ authorization, recipientPublicKey: controller.status().recipientPublicKey, credential: { username: 'x-access-token', token: 'private-token' } }, now) });
  return { controller, operations, response, publish };
}
describe('assignment source authority and job lifecycle', () => {
  it('prepares asynchronously, requires fresh attach authority, and never exposes secrets in status or journal', async () => {
    const { controller, operations, response } = fixture();
    expect(controller.prepare(response()).state).toBe('building');
    await vi.waitFor(() => expect(controller.status().state).toBe('ready'));
    operations.now = () => new Date(+now + 65_000);
    await expect(controller.attach(response())).rejects.toThrow('not current');
    expect(operations.createDisk).not.toHaveBeenCalled();
    const renewed = { ...authority, id: 'fresh', issuedAt: new Date(+now + 65_000).toISOString(), expiresAt: new Date(+now + 120_000).toISOString() };
    const envelope = { ...response(), authorization: renewed, credential: sealSourceCredential({ authorization: renewed,
      recipientPublicKey: controller.status().recipientPublicKey, credential: { username: 'x', token: 'private-token' } }, operations.now()) };
    const attached = await controller.attach(envelope);
    expect(attached.authorization.id).toBe('fresh');
    expect(operations.attachDisk).toHaveBeenCalledOnce();
    expect(JSON.stringify(controller.status())).not.toMatch(/private-token|ciphertext|privateKey|nbd/);
    expect(JSON.stringify(vi.mocked(operations.journal).mock.calls)).not.toMatch(/private-token|ciphertext|privateKey/);
  });
  it.each(['assignmentId', 'providerId', 'attempt'] as const)('rejects another %s before any source IO', key => {
    const { controller, operations, response } = fixture();
    expect(() => controller.prepare(response({ ...authority, [key]: key === 'attempt' ? 2 : 'other' }))).toThrow('signed assignment');
    expect(operations.build).not.toHaveBeenCalled();
  });
  it.each(['teamId', 'projectId'] as const)('rejects another source %s', key => {
    const { controller, response } = fixture();
    expect(() => controller.prepare(response({ ...authority, source: { ...authority.source, [key]: 'other' } }))).toThrow('signed assignment');
  });
  it('requires possession of the host-only recipient private key even for READY cache access', () => {
    const first = fixture(), second = fixture(); first.publish();
    expect(() => second.controller.prepare(first.response())).toThrow();
    expect(second.operations.build).not.toHaveBeenCalled();
  });
  it('does not start duplicate builds or expose backend error text', async () => {
    const { controller, operations, response } = fixture();
    operations.build = vi.fn(async () => { throw new Error('private-token from backend'); });
    controller.prepare(response()); controller.prepare(response());
    await vi.waitFor(() => expect(controller.status().state).toBe('failed'));
    expect(operations.build).toHaveBeenCalledOnce();
    expect(controller.status().error).toBe('source_preparation_failed');
    expect(() => controller.prepare(response())).toThrow('recovery');
  });
  it('retains disk ownership when attachment is uncertain and rejects implicit retry', async () => {
    const { controller, operations, response } = fixture();
    operations.attachDisk = vi.fn(async () => { throw new Error('NBD uncertain'); });
    controller.prepare(response()); await vi.waitFor(() => expect(controller.status().state).toBe('ready'));
    await expect(controller.attach(response())).rejects.toThrow('uncertain');
    const last = vi.mocked(operations.journal).mock.calls.at(-1)?.[0];
    expect(last?.disk).toMatchObject({ id: 'disk' });
    await expect(controller.attach(response())).rejects.toThrow('not ready');
  });
  it('cannot change source, credential binding, or publication authority during attachment', async () => {
    const { controller, response, operations } = fixture();
    controller.prepare(response()); await vi.waitFor(() => expect(controller.status().state).toBe('ready'));
    for (const next of [{ ...authority, source: { ...authority.source, commit: 'b'.repeat(40) } }, { ...authority, credentialBindingId: 'other' },
      { ...authority, mode: 'work' as const, publication: 'candidate-only' as const }]) {
      await expect(controller.attach(response(next))).rejects.toThrow('pinned');
    }
    expect(operations.createDisk).not.toHaveBeenCalled();
  });
  it('requires a fresh API envelope to renew and does not resurrect expired access', async () => {
    const { controller, response, operations } = fixture();
    controller.prepare(response()); await vi.waitFor(() => expect(controller.status().state).toBe('ready'));
    await controller.attach(response());
    await controller.renew(response({ ...authority, id: 'renewal', expiresAt: new Date(+now + 90_000).toISOString() }));
    operations.now = () => new Date(+now + 95_000);
    expect(() => controller.attachment()).toThrow('current');
    await expect(controller.renew(response({ ...authority, id: 'late', expiresAt: new Date(+now + 120_000).toISOString() }))).rejects.toThrow('expired');
  });
  it('drains preparation on cancellation and never attaches the cancelled assignment', async () => {
    const { controller, response, operations } = fixture();
    let complete!: () => void;
    operations.build = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    controller.prepare(response()); await vi.waitFor(() => expect(operations.build).toHaveBeenCalledOnce());
    const stopping = controller.stop(); complete(); await stopping;
    expect(controller.status().state).toBe('stopped');
    await expect(controller.attach(response())).rejects.toThrow('stopped');
    expect(operations.createDisk).not.toHaveBeenCalled();
  });
});
