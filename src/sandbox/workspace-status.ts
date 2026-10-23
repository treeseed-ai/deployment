import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sandboxResultSchema, sourceWorkspaceKeySchema, sourceWorkspaceAuthorizationSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { assignmentReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceStorageRoot } from './workspace-block-store.js';
import { inspectManagedDirectory, owningHostStat } from './directory-inspection.js';
import { simulationSourceRepository } from './simulation-source-repository.js';

type Disk = { id: string; type: 'directory' | 'file' | 'symlink' | 'other'; bytes: number | null;
 device: { id: string; device: string } | null };
const maximumDeviceIdentityBytes = 4096;

function optionalFile(path: string) {
 try {
  const stat = owningHostStat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path
   || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Owning metadata is redirected or malformed.');
  return stat;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
 }
}

/** Only fixed owning metadata reaches this bounded reader, never disk contents. */
function metadataFile(path: string, maximum: number, privateFile = false) {
 const stat = optionalFile(path); if (!stat) return null;
 if (stat.size > maximum || (privateFile && (stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)))
  throw new Error('Owning metadata exceeds its bounded private custody.');
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const held = fstatSync(fd);
  if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.size !== stat.size
   || held.mtimeMs !== stat.mtimeMs || held.ctimeMs !== stat.ctimeMs) throw new Error('Owning device identity changed.');
  const bytes = Buffer.alloc(maximum + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
  const final = owningHostStat(path);
  if (held.dev !== stat.dev || held.ino !== stat.ino || length !== stat.size || final.size !== stat.size
   || final.dev !== stat.dev || final.ino !== stat.ino || final.mtimeMs !== stat.mtimeMs || final.ctimeMs !== stat.ctimeMs
   || (privateFile && (final.uid !== stat.uid || final.mode !== stat.mode || final.nlink !== stat.nlink))) throw new Error('Owning device identity changed.');
  const content = bytes.subarray(0, length), value: unknown = JSON.parse(content.toString('utf8'));
  return { value, digest: createHash('sha256').update(content).digest('hex') };
 } finally { closeSync(fd); }
}

function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owning metadata must be an object.');
 return value as Record<string, unknown>;
}
function identity(value: unknown): string {
 if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(value))
  throw new Error('Owning identity is malformed.');
 return value;
}

/** Read only bounded device identity, never the encrypted disk or guest contents. */
function deviceIdentity(path: string, id: string) {
 const metadata = metadataFile(path, maximumDeviceIdentityBytes); if (!metadata) return null;
 const record = object(metadata.value);
  if (Object.keys(record).sort().join(',') !== 'device,id' || record.id !== id
   || typeof record.device !== 'string' || !/^\/dev\/nbd\d+$/u.test(record.device)) throw new Error('Owning device identity is malformed.');
  return { id, device: record.device };
}

function journalMetadata(kind: 'jobs' | 'candidates' | 'results', name: string, value: unknown) {
 const original = object(value), result: Record<string, unknown> = {};
 const fields = kind === 'jobs' ? ['schemaVersion', 'state', 'leaseId'] : kind === 'candidates'
  ? ['state', 'assignmentId', 'attempt', 'providerId', 'verifierId', 'verifierStopped']
  : ['schemaVersion', 'sandboxId', 'leaseId', 'status', 'teardownVerified', 'completedAt'];
 for (const field of fields) if (Object.hasOwn(original, field)) {
  const input = original[field];
  if (['verifierStopped', 'teardownVerified'].includes(field)) { if (typeof input !== 'boolean') throw new Error(); }
  else if (field === 'attempt') { if (!Number.isSafeInteger(input) || Number(input) < 1) throw new Error(); }
  else if (field !== 'schemaVersion') identity(input);
  result[field] = input;
 }
 if (kind === 'jobs') {
  if (result.schemaVersion !== 'treeseed.assignment-source-job/v1'
   || !['awaiting-authority', 'building', 'ready', 'attaching', 'attached', 'failed', 'stopped'].includes(String(result.state))) throw new Error();
  const owner = object(original.owner), held: Record<string, unknown> = {};
  for (const field of ['assignmentId', 'providerId', 'teamId', 'projectId']) held[field] = identity(owner[field]);
  if (!Number.isSafeInteger(owner.attempt) || Number(owner.attempt) < 1) throw new Error();
  held.attempt = owner.attempt; result.owner = held;
  if (Object.hasOwn(original, 'authority')) {
   const authority = sourceWorkspaceAuthorizationSchema.parse(original.authority);
   if (authority.assignmentId !== owner.assignmentId || authority.providerId !== owner.providerId
    || authority.attempt !== owner.attempt || authority.source.teamId !== owner.teamId
    || authority.source.projectId !== owner.projectId) throw new Error('Owning source authority differs from its job owner.');
   result.authority = authority;
  }

  if (Object.hasOwn(original, 'disk')) {
   const disk = object(original.disk), id = identity(disk.id), directory = join(workspaceStorageRoot, 'leases', id);
   if (!/^workspace-lease-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)
    || disk.directory !== directory || disk.image !== join(directory, 'work.qcow2')) throw new Error();
   const observed: Record<string, unknown> = { id, directory, image: disk.image };
   if (Object.hasOwn(disk, 'device')) {
    if (typeof disk.device !== 'string' || !/^\/dev\/nbd\d+$/u.test(disk.device)) throw new Error();
    observed.device = disk.device;
   }
   if (Object.hasOwn(disk, 'unit')) { if (disk.unit !== `treeseed-${id}.service`) throw new Error(); observed.unit = disk.unit; }
   result.disk = observed;
  }
  if (Object.hasOwn(original, 'builderIds')) {
   if (!Array.isArray(original.builderIds) || !original.builderIds.every(id => typeof id === 'string'
    && /^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
    || new Set(original.builderIds).size !== original.builderIds.length) throw new Error();
   result.builderIds = original.builderIds;
  }
 } else if (kind === 'candidates') {
  identity(result.assignmentId);
  if (!['verifying', 'published', 'retained'].includes(String(result.state))) throw new Error();
  if (result.state === 'published' && (result.attempt === undefined || result.providerId === undefined
   || typeof result.verifierId !== 'string' || !/^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(result.verifierId)
   || typeof result.verifierStopped !== 'boolean')) throw new Error();
  if (result.state === 'published' || ['leaseId', 'source', 'commit', 'verification', 'digest'].some(field => Object.hasOwn(original, field))) {
   const source = sourceWorkspaceKeySchema.parse(original.source), verification = object(original.verification);
   if (Object.keys(verification).sort().join(',') !== 'ancestry,baseCommit,bytes,clean,commit,isolatedVerifier,objectClosure'
    || verification.baseCommit !== source.commit || verification.commit !== original.commit
    || typeof original.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(original.commit)
    || !Number.isSafeInteger(verification.bytes) || Number(verification.bytes) < 1
    || ['clean', 'objectClosure', 'ancestry', 'isolatedVerifier'].some(field => verification[field] !== true)
    || typeof original.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(original.digest)
    || !Number.isSafeInteger(result.attempt) || Number(result.attempt) < 1 || !result.providerId
    || typeof result.verifierId !== 'string' || !/^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(result.verifierId)
    || result.verifierStopped !== true) throw new Error();
   result.leaseId = identity(original.leaseId); result.source = source; result.commit = original.commit;
   result.verification = verification; result.digest = original.digest;
  }
 } else {
  if (result.schemaVersion !== 'treeseed.source-result/v1' || result.sandboxId !== name.slice(0, -5)
   || !result.leaseId || (result.status !== 'interrupted' && !sandboxResultSchema.shape.status.safeParse(result.status).success)
   || typeof result.teardownVerified !== 'boolean'
   || typeof result.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.completedAt)
   || !Number.isFinite(Date.parse(result.completedAt)) || new Date(result.completedAt).toISOString() !== result.completedAt) throw new Error();
  if (Object.hasOwn(original, 'source')) {
   const source = sourceWorkspaceKeySchema.parse(original.source);
   result.source = source;
   const reference = original.sourceReference == null ? null : assignmentReferenceSchema.parse(original.sourceReference);
   if (reference !== null && reference.kind !== 'git') throw new Error();
   result.sourceReference = reference;
   // A fixed owning locator is not proof of publication or ancestry. Consumers
   // independently resolve the original Git objects and canonical references.
   const repository = simulationSourceRepository(workspaceStorageRoot, source);
   let present = false;
   try {
    const stat = owningHostStat(repository);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(repository) !== repository) throw new Error();
    present = true;
   } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
   result.simulationRepository = present ? repository : null;
  } else if (original.sourceReference != null) throw new Error();
 }
 return result;
}

/** Reuse the canonical bounded private journal parser for one fixed source publication. */
export function readSourcePublicationJournal(kind: 'jobs' | 'candidates' | 'results', sandboxId: string) {
 if (!/^sandbox-[a-zA-Z0-9-]{1,128}$/u.test(sandboxId)) throw new Error('Invalid source export sandbox.');
 const root = join(workspaceStorageRoot, kind);
 for (const path of [workspaceStorageRoot, root]) {
  const stat = owningHostStat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path)
   throw new Error('Source journal escaped private manager custody.');
 }
 const name = sandboxId + '.json', metadata = metadataFile(join(root, name), 1_048_576, true);
 if (!metadata) throw new Error('Source publication journal unavailable.');
 return journalMetadata(kind, name, metadata.value);
}

/** A bounded original status read. It reports journal custody only, never current physical state. */
export function retainedSourceStatus(assignmentId: string, sandboxId: string) {
 try {
  const job = readSourcePublicationJournal('jobs', sandboxId);
  const result = readSourcePublicationJournal('results', sandboxId);
  const owner = job.owner as Record<string, unknown>;
  if (owner.assignmentId !== assignmentId || result.sandboxId !== sandboxId || !job.leaseId || job.leaseId !== result.leaseId)
   return { available: false as const, reason: 'source_owner_binding_conflict' };
  const authority = job.authority as Record<string, unknown> | undefined;
  const source = authority?.source as Record<string, unknown> | undefined;
  return { available: true as const, assignmentId, sandboxId, owner: {
   assignmentId: owner.assignmentId, providerId: owner.providerId, teamId: owner.teamId,
   projectId: owner.projectId, attempt: owner.attempt,
  }, state: job.state, leaseId: job.leaseId, source: source ? {
   controlPlaneId: source.controlPlaneId, teamId: source.teamId, projectId: source.projectId,
   repositoryId: source.repositoryId, commit: source.commit, formatVersion: source.formatVersion, profile: source.profile,
  } : null, authority: authority ? {
   mode: authority.mode, acquisition: authority.acquisition, publication: authority.publication,
   publicationRef: authority.publicationRef, issuedAt: authority.issuedAt, expiresAt: authority.expiresAt,
  } : null, result: { status: result.status, teardownVerified: result.teardownVerified, completedAt: result.completedAt },
   physicalStatus: 'not_observed' as const };
 } catch { return { available: false as const, reason: 'source_journal_unavailable' }; }
}

function journalInventory(kind: 'jobs' | 'candidates' | 'results', errors: Set<string>) {
 const observed = { rootPresent: null as boolean | null, entries: [] as Array<{ name: string; type: Disk['type'];
  metadata: Record<string, unknown> | null; digest: string | null }> };
 try {
  const root = join(workspaceStorageRoot, kind), directory = { rootPresent: null as boolean | null,
   entries: [] as Array<{ name: string; type: Disk['type'] }> };
  try { inspectManagedDirectory(root, directory); }
  finally { observed.rootPresent = directory.rootPresent; observed.entries = directory.entries.map(entry => ({ ...entry, metadata: null, digest: null })); }
  if (directory.rootPresent) {
   const stat = owningHostStat(root);
   if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error();
  }
  for (const entry of observed.entries) try {
   if (entry.type !== 'file' || !/^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(entry.name)) throw new Error();
   const metadata = metadataFile(join(root, entry.name), 1_048_576, true); if (!metadata) throw new Error();
   entry.digest = metadata.digest; entry.metadata = journalMetadata(kind, entry.name, metadata.value);
  } catch { errors.add(`workspace_${kind}_metadata_unavailable`); }
 } catch { errors.add(`workspace_${kind}_inventory_unavailable`); }
 return observed;
}

/** Fixed read-only observations, independent of catalog availability. No runtime
 * is constructed, disk content read, or catalog/directory repaired here. */
export function workspaceStatus() {
 const startedAt = new Date().toISOString(), errors = new Set<string>();
 let mountNamespace: string | null = null, rootVerified = false;
 try {
  mountNamespace = readlinkSync('/proc/1/ns/mnt');
  if (!/^mnt:\[\d+\]$/u.test(mountNamespace)) throw new Error();
  rootVerified = realpathSync(workspaceStorageRoot) === workspaceStorageRoot && owningHostStat(workspaceStorageRoot).isDirectory();
  if (!rootVerified) throw new Error();
 } catch { errors.add('workspace_lease_inventory_unavailable'); }
 let storage: { totalBytes: number; availableBytes: number } | null = null;
 try {
  if (!rootVerified) throw new Error();
  const capacity = statfsSync(workspaceStorageRoot);
  const totalBytes = capacity.blocks * capacity.bsize, availableBytes = capacity.bavail * capacity.bsize;
  if (![totalBytes, availableBytes].every(value => Number.isSafeInteger(value) && value >= 0)
   || availableBytes > totalBytes) throw new Error();
  storage = { totalBytes, availableBytes };
 } catch { errors.add('workspace_storage_capacity_unavailable'); }
 const observe = () => {
  const directory = { rootPresent: null as boolean | null,
   entries: [] as Array<{ name: string; type: Disk['type'] }> };
  const disks: Disk[] = [];
  try {
   if (!rootVerified) throw new Error();
   inspectManagedDirectory(join(workspaceStorageRoot, 'leases'), directory);
   for (const entry of directory.entries) {
    const disk: Disk = { id: entry.name, type: entry.type, bytes: null, device: null }; disks.push(disk);
    try {
     if (entry.type !== 'directory' || !/^workspace-lease-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(entry.name)) throw new Error();
     const root = join(workspaceStorageRoot, 'leases', entry.name);
     if (realpathSync(root) !== root) throw new Error();
     disk.bytes = optionalFile(join(root, 'work.qcow2'))?.size ?? null;
     disk.device = deviceIdentity(join(root, 'device.json'), entry.name);
    } catch { errors.add('workspace_lease_metadata_unavailable'); }
   }
  } catch { errors.add('workspace_lease_inventory_unavailable'); }
  const journals = rootVerified ? { jobs: journalInventory('jobs', errors), candidates: journalInventory('candidates', errors),
   results: journalInventory('results', errors) } : null;
  return { leaseDirectoryPresent: directory.rootPresent, disks, journals };
 };
 const observed = observe();
 let initialized = false, images: unknown[] | null = null, leases: unknown[] | null = null;
 try {
  if (!rootVerified) throw new Error();
  const database = join(workspaceStorageRoot, 'catalog.db'), stat = owningHostStat(database); initialized = true;
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(database) !== database) throw new Error();
  const db = new DatabaseSync(database, { readOnly: true });
  try {
   db.exec('BEGIN');
   const heldImages = db.prepare('SELECT id,state,job_id,bytes,parent_id FROM workspace_images ORDER BY id').all();
   const heldLeases = db.prepare('SELECT id,image_id,provider_id,assignment_id,attempt,mode,acquisition,publication,expires_at,state,result_artifact_id FROM workspace_leases ORDER BY id').all();
   db.exec('COMMIT'); images = heldImages; leases = heldLeases;
  } finally { db.close(); }
 } catch { errors.add('workspace_catalog_unavailable'); }
 const confirmation = observe();
 if (JSON.stringify(observed) !== JSON.stringify(confirmation)) errors.add('workspace_inventory_changed');
 let confirmedNamespace: string | null = null;
 try {
  confirmedNamespace = readlinkSync('/proc/1/ns/mnt');
  if (confirmedNamespace !== mountNamespace) errors.add('workspace_inventory_changed');
 } catch { errors.add('workspace_lease_inventory_unavailable'); }
 return { startedAt, completedAt: new Date().toISOString(), complete: errors.size === 0,
  scope: { storageRoot: workspaceStorageRoot, mountNamespace }, storage, initialized, images, leases,
  ...observed, confirmation: { ...confirmation, mountNamespace: confirmedNamespace }, errors: [...errors] };
}
