import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxAssignment, SandboxResult } from '@treeseed/sdk/capacity-provider/sandbox';
import { openSourceCredential } from '../security/services/source-credential-delivery.js';
import { AssignmentSource } from './assignment-source.js';
import { WorkspaceCatalog, sourceWorkspaceId } from './workspace-catalog.js';
import { acquireSourceBundle } from './source-git-cache.js';
import { buildWorkspaceImage } from './workspace-image-builder.js';
import { initializeWorkspaceStorage, workspaceStorageRoot, createWorkspaceDisk, attachWorkspaceDisk, detachWorkspaceDisk } from './workspace-block-store.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { SourcePublicationJob } from './source-publication-job.js';
import { candidateVmVerifier } from './workspace-candidate-vm.js';
import { publishVerifiedSourceBranch } from './source-branch-publication.js';

/** Bounded host worker scheduling, independent of the HTTP lifetime. One image build at a time. */
export class SourceBuildQueue {
  private running = false;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly maxWaiting = 8) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.waiting.length >= this.maxWaiting) throw new Error('Source build admission is full.');
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.running = true;
    try { return await operation(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.running = false; }
  }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) || await realpath(path) !== path) throw new Error('Source journal requires private manager custody.');
}
async function durableJson(directory: string, name: string, value: unknown) {
  await privateDirectory(directory);
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(directory, name));
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}

export class AssignmentSourceStore {
  private catalog?: WorkspaceCatalog;
  private initialization?: Promise<WorkspaceCatalog>;
  private readonly queue = new SourceBuildQueue();
  private readonly publications = new Map<string, SourcePublicationJob>();
  private readonly executionDetached = new Set<string>();
  constructor(private readonly configuration: SandboxBrokerConfiguration) {}
  private initialize() {
    return this.initialization ??= (async () => {
      await initializeWorkspaceStorage();
      this.catalog = new WorkspaceCatalog(join(workspaceStorageRoot, 'catalog.db'));
      return this.catalog;
    })();
  }
  async create(sandboxId: string, assignment: SandboxAssignment) {
    if (!/^sandbox-[a-zA-Z0-9-]{1,128}$/u.test(sandboxId)) throw new Error('Invalid source job identity.');
    const catalog = await this.initialize();
    const owner = { assignmentId: assignment.assignmentId, providerId: assignment.providerId,
      teamId: assignment.teamId, projectId: assignment.projectId, attempt: assignment.attempt };
    return new AssignmentSource(owner, assignment.resources.diskBytes, {
      catalog, now: () => new Date(), createDisk: createWorkspaceDisk, attachDisk: attachWorkspaceDisk,
      journal: value => durableJson(join(workspaceStorageRoot, 'jobs'), `${sandboxId}.json`, value),
      build: (response, privateKey, virtualBytes) => this.queue.run(async () => {
        // Queue residence consumes credential lifetime. Always recheck before touching the cache.
        const credential = openSourceCredential({ authorization: response.authorization, delivery: response.credential, privateKey });
        try {
          const image = catalog.image(sourceWorkspaceId(response.authorization.source));
          if (image?.state === 'ready') return;
          const bundle = await acquireSourceBundle({ authorization: response.authorization, repository: response.repository,
            credential, maxBundleBytes: Math.min(virtualBytes, 8_589_934_592) });
          await buildWorkspaceImage(this.configuration, catalog, { source: response.authorization.source, bundleDigest: bundle.bundleDigest, virtualBytes });
        } finally { credential.token = ''; credential.username = ''; }
      }),
    });
  }
  startPublication(sandboxId: string, source: AssignmentSource, assignment: SandboxAssignment, authority: unknown, commit: string, executionStopped: boolean) {
    const previous = this.publications.get(sandboxId);
    if (previous) {
      if (previous.commit !== commit) throw new Error('Source publication is already pinned to another revision.');
      return previous.status();
    }
    const current = () => {
      const attached = source.attachment();
      this.catalog!.assertCandidateAuthority(attached.leaseId, attached.authorization.id);
      return attached;
    };
    current();
    const job = new SourcePublicationJob(assignment, commit, Math.min(assignment.resources.outputBytes, 536870912), executionStopped, {
      now: () => new Date(), current, verify: candidateVmVerifier(this.configuration),
      journal: value => durableJson(join(workspaceStorageRoot, 'candidates'), `${sandboxId}.json`, value),
      publish: async (bundlePath) => {
        const publication = source.publicationCredential(authority);
        return publishVerifiedSourceBranch({ assignmentId: assignment.assignmentId, attempt: assignment.attempt,
          commit, bundlePath, ...publication });
      },
      detachExecution: async disk => {
        if (!this.executionDetached.has(sandboxId)) { await detachWorkspaceDisk(disk, true); this.executionDetached.add(sandboxId); }
      },
    });
    this.publications.set(sandboxId, job); return job.status();
  }
  publication(sandboxId: string) {
    const job = this.publications.get(sandboxId);
    if (!job) throw new Error('Source publication has not started.');
    return job;
  }
  /** Called only after verified execution VM destruction. Work storage remains until durable candidate acceptance. */
  async finish(sandboxId: string, source: AssignmentSource, result: SandboxResult | undefined, guestStopped: boolean) {
    const publication = this.publications.get(sandboxId);
    await publication?.drain();
    const retained = await source.stop();
    if (!guestStopped) return { released: false, reason: 'guest_teardown_unverified' };
    if (!retained.disk || !retained.leaseId || !retained.authorization) return { released: false, reason: 'source_job_retained' };
    if (!this.executionDetached.has(sandboxId)) await detachWorkspaceDisk(retained.disk, true);
    if (retained.authorization.mode === 'work' && !publication?.publishedReference()) return { released: false, reason: 'source_publication_required' };
    const receiptId = `${sandboxId}.json`;
    await durableJson(join(workspaceStorageRoot, 'results'), receiptId, { schemaVersion: 'treeseed.source-result/v1',
      sandboxId, leaseId: retained.leaseId, source: retained.authorization.source,
      status: result?.status ?? 'interrupted', result: result ?? null, sourceReference: publication?.publishedReference() ?? null,
      teardownVerified: true, completedAt: new Date().toISOString() });
    this.catalog!.recordDurableResult(retained.leaseId, receiptId);
    this.catalog!.release(retained.leaseId, true);
    // The directory was generated and validated by the block store, never supplied by the guest or API.
    await rm(retained.disk.directory, { recursive: true });
    this.publications.delete(sandboxId); this.executionDetached.delete(sandboxId);
    return { released: true, receiptId };
  }
}
