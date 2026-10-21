import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sourceWorkspaceKeySchema, sourceWorkspaceAuthorizationSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { assignmentReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { sourceExportSelectionSchema } from './protocol.js';
import { readSourcePublicationJournal } from './workspace-status.js';
import { simulationSourceRepository } from './simulation-source-repository.js';
import { workspaceStorageRoot } from './workspace-block-store.js';
import { runSourceGit } from './source-git-transport.js';

// This operator transfer has its own fixed bound; it cannot expand issued agent authority.
export const maximumSourceExportBytes = 32 * 1024 * 1024;
function record(value: unknown) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source export journal object required.');
 return value as Record<string, unknown>;
}
async function privateDirectory(path: string, create = false) {
 if (create) await mkdir(path, { recursive: true, mode: 0o700 });
 const stat = await lstat(path);
 if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path)
  throw new Error('Source export escaped private manager custody.');
}

/** Local operator read of an already completed publication, never a guest publication path. */
export async function exportPublishedSource(input: unknown) {
 const selection = sourceExportSelectionSchema.parse(input);
 const job = readSourcePublicationJournal('jobs', selection.sandboxId);
 const candidate = readSourcePublicationJournal('candidates', selection.sandboxId);
 const result = readSourcePublicationJournal('results', selection.sandboxId);
 const owner = record(job.owner), authority = sourceWorkspaceAuthorizationSchema.parse(job.authority);
 const reference = assignmentReferenceSchema.parse(result.sourceReference);
 const verification = record(candidate.verification);
 if (!isDeepStrictEqual(owner, { assignmentId: selection.assignmentId, providerId: selection.providerId,
   teamId: selection.source.teamId, projectId: selection.source.projectId, attempt: selection.attempt })
  || job.state !== 'stopped' || authority.mode !== 'work' || authority.publication !== 'simulation-branch'
  || authority.assignmentId !== selection.assignmentId || authority.providerId !== selection.providerId || authority.attempt !== selection.attempt
  || candidate.assignmentId !== selection.assignmentId || candidate.providerId !== selection.providerId || candidate.attempt !== selection.attempt
  || candidate.state !== 'published' || candidate.verifierStopped !== true || candidate.commit !== selection.commit
  || result.status !== 'completed' || result.teardownVerified !== true || result.sandboxId !== selection.sandboxId
  || job.leaseId !== result.leaseId || candidate.leaseId !== result.leaseId
  || !isDeepStrictEqual(authority.source, selection.source) || !isDeepStrictEqual(candidate.source, selection.source)
  || !isDeepStrictEqual(result.source, selection.source)
  || reference.kind !== 'git' || reference.repository !== selection.source.repositoryId || reference.commit !== selection.commit
  || typeof reference.branch !== 'string' || !reference.branch.startsWith('simulation/') || authority.publicationRef !== reference.branch
  || verification.baseCommit !== selection.source.commit || verification.commit !== selection.commit
  || ['clean', 'objectClosure', 'ancestry', 'isolatedVerifier'].some(key => verification[key] !== true)
  || !Number.isSafeInteger(verification.bytes) || Number(verification.bytes) < 1 || Number(verification.bytes) > maximumSourceExportBytes)
  throw new Error('Completed source publication bindings do not match the requested export.');
 const repository = simulationSourceRepository(workspaceStorageRoot, selection.source);
 await privateDirectory(workspaceStorageRoot); await privateDirectory(join(workspaceStorageRoot, 'simulations'));
 await privateDirectory(repository);
 const ref = `refs/heads/${reference.branch}`;
 await runSourceGit(repository, ['check-ref-format', ref]);
 if (await runSourceGit(repository, ['rev-parse', '--verify', `${ref}^{commit}`]) !== selection.commit)
  throw new Error('Published source ref moved.');
 await runSourceGit(repository, ['merge-base', '--is-ancestor', selection.source.commit, selection.commit]);
 await runSourceGit(repository, ['fsck', '--strict', '--no-reflogs', selection.commit]);
 const parent = join(workspaceStorageRoot, 'publications'); await privateDirectory(parent, true);
 const directory = await mkdtemp(join(parent, 'export-'));
 try {
  const path = join(directory, 'source.bundle');
  await runSourceGit(repository, ['bundle', 'create', path, ref]);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > maximumSourceExportBytes
   || await realpath(path) !== path) throw new Error('Source export exceeds its fixed bundle bound.');
  await runSourceGit(repository, ['bundle', 'verify', path]);
  if (await runSourceGit(repository, ['bundle', 'list-heads', path]) !== `${selection.commit} ${ref}`)
   throw new Error('Exported bundle changed published source identity.');
  const bytes = await readFile(path);
  if (bytes.length !== stat.size || bytes.length > maximumSourceExportBytes) throw new Error('Source export size changed.');
  return { sandboxId: selection.sandboxId, assignmentId: selection.assignmentId, sourceReference: reference,
   bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bundleBase64: bytes.toString('base64') };
 } finally { await rm(directory, { recursive: true, force: true }); }
}
