import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceWorkspaceAuthorizationSchema, type SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { initializeWorkspaceStorage, workspaceStorageRoot } from './workspace-block-store.js';
import { runSourceGit, type SourceGitCredential } from './source-git-transport.js';
import { withSourceCacheVolume } from './source-cache-volume.js';
import { recoverSourceCacheFence } from './source-cache-recovery.js';

interface Repository { owner: string; name: string; cloneUrl: string }
export interface SourceGitCacheDependencies {
  root: string;
  initialize(): Promise<void>;
  run: typeof runSourceGit;
  now(): Date;
  volume: typeof withSourceCacheVolume;
}
const production: SourceGitCacheDependencies = { root: workspaceStorageRoot, initialize: initializeWorkspaceStorage, run: runSourceGit, now: () => new Date(), volume: withSourceCacheVolume };

function current(authorization: SourceWorkspaceAuthorization, now: Date) {
  if (Date.parse(authorization.issuedAt) > now.getTime() || Date.parse(authorization.expiresAt) <= now.getTime()) throw new Error('Source acquisition authority expired.');
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error('Source cache directory escaped private custody.');
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

/** Caller must reauthorize through API/Vault before EVERY acquisition, including an existing local object. */
export async function acquireSourceBundle(input: {
  authorization: SourceWorkspaceAuthorization; repository: Repository; credential: SourceGitCredential;
  maxBundleBytes: number;
}, dependencies: SourceGitCacheDependencies = production) {
  const authorization = sourceWorkspaceAuthorizationSchema.parse(input.authorization), repository = input.repository;
  current(authorization, dependencies.now());
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(repository.owner) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(repository.name)
    || repository.cloneUrl !== `https://github.com/${repository.owner}/${repository.name}.git`) throw new Error('Invalid canonical source repository.');
  if (!Number.isSafeInteger(input.maxBundleBytes) || input.maxBundleBytes < 1 || input.maxBundleBytes > 8_589_934_592) throw new Error('Invalid source bundle limit.');
  await dependencies.initialize();
  const source = authorization.source;
  const identity = { controlPlaneId: source.controlPlaneId, teamId: source.teamId, projectId: source.projectId, repositoryId: source.repositoryId, repository };
  const cacheId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const root = join(dependencies.root, 'git'), bundles = join(dependencies.root, 'bundles'), cache = join(root, cacheId);
  for (const directory of [root, bundles, cache]) await privateDirectory(directory);
  // An abandoned lock stays fenced until manager recovery proves its job has stopped. No timeout-based stealing.
  const lock = join(cache, 'acquisition.lock');
  if (dependencies === production) await recoverSourceCacheFence(cache);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Source acquisition is already owned or awaiting recovery.'); throw error; }
  const jobId = randomUUID();
  let completed = false;
  try {
    await writeFile(join(lock, 'job.json'), JSON.stringify({ jobId, assignmentId: authorization.assignmentId, authorizationId: authorization.id, pid: process.pid }), { mode: 0o600, flag: 'wx' });
    const result = await dependencies.volume(cache, input.maxBundleBytes, async volume => {
    const temporary = join(volume, `${jobId}.bundle`), git = join(volume, 'repository.git');
    await privateDirectory(git);
    await dependencies.run(git, ['init', '--bare', '--template=']);
    // The manager never accepts a remote config or filesystem from an execution guest.
    await dependencies.run(git, ['fetch', '--no-tags', '--no-recurse-submodules', repository.cloneUrl, source.commit], input.credential);
    current(authorization, dependencies.now());
    if (await dependencies.run(git, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']) !== source.commit) throw new Error('Fetched source differs from the authorized exact revision.');
    await dependencies.run(git, ['fsck', '--strict', '--no-reflogs', source.commit]);
    await dependencies.run(git, ['update-ref', 'refs/heads/treeseed-source', source.commit]);
    await dependencies.run(git, ['bundle', 'create', temporary, 'refs/heads/treeseed-source']);
    const info = await lstat(temporary);
    if (!info.isFile() || info.size < 1 || info.size > input.maxBundleBytes) throw new Error('Source bundle exceeds the admitted transfer limit.');
    const sha256 = await digest(temporary), path = join(bundles, `${sha256}.bundle`);
    const staged = join(lock, `${jobId}.verified`);
    await copyFile(temporary, staged, constants.COPYFILE_EXCL); await chmod(staged, 0o400);
    try { await link(staged, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o222) !== 0 || await realpath(path) !== path || await digest(path) !== sha256) throw new Error('Existing source bundle failed immutable custody verification.');
    }
    const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const directory = await open(bundles, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    current(authorization, dependencies.now());
    await rm(temporary);
    return { cacheId, bundleDigest: `sha256:${sha256}`, bytes: info.size, commit: source.commit };
    });
    completed = true; return result;
  } finally {
    // Failed or interrupted Git may have descendants still writing. Recovery, not elapsed time, releases this fence.
    if (completed) await rm(lock, { recursive: true });
  }
}
