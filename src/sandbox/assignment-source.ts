import type { KeyObject } from 'node:crypto';
import { sourceWorkspaceResponseSchema, type SandboxAssignment, type SourceWorkspaceAuthorization, type SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { createSourceCredentialRecipient, openSourceCredential } from '../security/services/source-credential-delivery.js';
import { sourceWorkspaceId, type WorkspaceCatalog } from './workspace-catalog.js';
import type { WorkspaceDisk } from './workspace-block-store.js';

type Owner = Pick<SandboxAssignment, 'assignmentId' | 'providerId' | 'teamId' | 'projectId' | 'attempt'>;
type State = 'awaiting-authority' | 'building' | 'ready' | 'attaching' | 'attached' | 'failed' | 'stopped';
export interface AssignmentSourceOperations {
  catalog: WorkspaceCatalog;
  now(): Date;
  build(response: SourceWorkspaceResponse, privateKey: KeyObject, virtualBytes: number): Promise<void>;
  createDisk(imageId: string, virtualBytes: number): Promise<Pick<WorkspaceDisk, 'id' | 'directory' | 'image'>>;
  attachDisk(disk: Pick<WorkspaceDisk, 'id' | 'directory' | 'image'>): Promise<WorkspaceDisk>;
  journal(value: Record<string, unknown>): Promise<void>;
}

/** Host-only controller. The caller is the authenticated provider manager, NOT the guest relay.
 * That trusted manager forwards the response obtained using its Identity-authenticated API client.
 * Encryption protects Git delivery; it is not a substitute for authenticating that caller. */
export class AssignmentSource {
  private readonly recipient = createSourceCredentialRecipient();
  private state: State = 'awaiting-authority';
  private authority?: SourceWorkspaceAuthorization;
  private leaseId?: string;
  private disk?: WorkspaceDisk;
  private allocatedDisk?: Pick<WorkspaceDisk, 'id' | 'directory' | 'image'>;
  private stopped = false;
  private pending?: Promise<void>;
  private failure?: string;
  private predecessor: string | null = null;
  constructor(private readonly owner: Owner, private readonly virtualBytes: number, private readonly operations: AssignmentSourceOperations) {
    if (!Number.isSafeInteger(virtualBytes) || virtualBytes < 67_108_864 || virtualBytes > 137_438_953_472) throw new Error('Invalid assignment source disk limit.');
  }
  status() {
    return { state: this.state, recipientPublicKey: this.recipient.publicKey,
      ...(this.authority ? { source: this.authority.source, mode: this.authority.mode, publication: this.authority.publication } : {}),
      ...(this.leaseId ? { leaseId: this.leaseId, expiresAt: this.authority?.expiresAt } : {}),
      ...(this.failure ? { error: this.failure } : {}) };
  }
  predecessorId() { return this.predecessor; }
  authorizeTransfer(value: unknown) { return this.validate(value); }
  private validate(value: unknown) {
    if (this.stopped) throw new Error('Assignment source is stopped.');
    const response = sourceWorkspaceResponseSchema.parse(value), authorization = response.authorization;
    if (authorization.assignmentId !== this.owner.assignmentId || authorization.providerId !== this.owner.providerId
      || authorization.source.teamId !== this.owner.teamId || authorization.source.projectId !== this.owner.projectId
      || authorization.attempt !== this.owner.attempt) throw new Error('Source authorization does not match the signed assignment.');
    const opened = openSourceCredential({ authorization, delivery: response.credential, privateKey: this.recipient.privateKey }, this.operations.now());
    // Authenticate the sealed delivery even on a cache hit or renewal. Never retain plaintext.
    opened.token = ''; opened.username = '';
    if (this.authority && (sourceWorkspaceId(this.authority.source) !== sourceWorkspaceId(authorization.source)
      || this.authority.credentialBindingId !== authorization.credentialBindingId || this.authority.mode !== authorization.mode
      || this.authority.publication !== authorization.publication || this.predecessor !== (response.sourceBundle?.artifactId ?? null))) throw new Error('Source authorization changed the pinned assignment scope.');
    return response;
  }
  /** Returns immediately. Long Git and VM operations must never occupy a broker HTTP request. */
  prepare(value: unknown) {
    const response = this.validate(value);
    if (this.state === 'building' || this.state === 'ready' || this.state === 'attached') return this.status();
    if (this.state !== 'awaiting-authority') throw new Error('Source preparation requires recovery after failure.');
    this.authority = response.authorization;
    this.predecessor = response.sourceBundle?.artifactId ?? null;
    this.state = 'building';
    this.pending = (async () => {
      try {
        await this.persist();
        if (!this.stopped) await this.operations.build(response, this.recipient.privateKey, this.virtualBytes);
        if (!this.stopped) this.state = 'ready';
      } catch {
        // Backend failures may contain transport details. Only bounded diagnostic codes leave this boundary.
        if (!this.stopped) { this.state = 'failed'; this.failure = 'source_preparation_failed'; }
      } finally { await this.persist(); }
    })();
    // A journal failure must remain observable, not become an unhandled rejection.
    void this.pending.catch(() => { this.state = 'failed'; this.failure = 'source_custody_journal_failed'; });
    return this.status();
  }
  /** Fresh API authority is required AFTER a cold build, before any execution VM receives storage. */
  async attach(value: unknown) {
    const response = this.validate(value);
    if (this.state === 'attached') { await this.renew(response); return this.attachment(); }
    if (this.state !== 'ready') throw new Error('Assignment source image is not ready for attachment.');
    this.state = 'attaching';
    const operation = (async () => {
      this.authority = response.authorization;
      const lease = this.operations.catalog.lease(response.authorization, this.operations.now());
      this.leaseId = lease.id;
      await this.persist();
      const disk = await this.operations.createDisk(lease.imageId, this.virtualBytes);
      this.allocatedDisk = disk;
      // Persist disk ownership BEFORE starting NBD; failed attachment is recoverable without guessing paths.
      await this.operations.journal({ ...this.snapshot(), disk });
      if (this.stopped) throw new Error('Source attachment was stopped.');
      this.disk = await this.operations.attachDisk(disk);
      if (this.stopped || Date.parse(response.authorization.expiresAt) <= this.operations.now().getTime()) throw new Error('Source authority expired during attachment.');
      this.state = 'attached';
      await this.persist();
    })();
    this.pending = operation;
    try { await operation; return this.attachment(); }
    catch (error) { if (!this.stopped) { this.state = 'failed'; this.failure = 'source_attachment_quarantined'; } await this.persist(); throw error; }
  }
  async renew(value: unknown) {
    const response = this.validate(value);
    if (this.state !== 'attached' || !this.leaseId) throw new Error('No attached source lease can be renewed.');
    this.operations.catalog.renew(this.leaseId, response.authorization, this.operations.now());
    this.authority = response.authorization;
    await this.persist();
    return this.status();
  }
  attachment() {
    if (this.stopped || this.state !== 'attached' || !this.disk || !this.authority || !this.leaseId
      || Date.parse(this.authority.expiresAt) <= this.operations.now().getTime()) throw new Error('Assignment has no current attached source authority.');
    return { disk: this.disk, leaseId: this.leaseId, authorization: this.authority };
  }
  private snapshot() {
    return { schemaVersion: 'treeseed.assignment-source-job/v1', owner: this.owner, state: this.state,
      authority: this.authority, leaseId: this.leaseId, disk: this.disk ?? this.allocatedDisk, failure: this.failure };
  }
  private persist() { return this.operations.journal(this.snapshot()); }
  /** Drain in-flight preparation before teardown. Never detach or delete here: caller must prove VM exit. */
  async stop() {
    this.stopped = true;
    await this.pending?.catch(() => undefined);
    this.state = 'stopped';
    await this.persist();
    return { disk: this.disk, leaseId: this.leaseId, authorization: this.authority };
  }
}
