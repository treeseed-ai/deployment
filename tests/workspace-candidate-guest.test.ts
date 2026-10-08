import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFailed, vi } from 'vitest';
import type { SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { simulationSourceRepository } from '../src/sandbox/simulation-source-repository.js';
import { verifySourceCandidate } from '../src/sandbox/workspace-candidate-guest.js';
import { buildSourceWorkspace } from '../src/sandbox/workspace-builder-guest.js';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { attachWorkspaceDisk, createWorkspaceDisk, detachWorkspaceDisk, workspaceImagePath, workspaceStorageRoot } from '../src/sandbox/workspace-block-store.js';
import { sandboxBrokerConfigurationSchema } from '../src/sandbox/protocol.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'treeseed-candidate-test-')), root = join(directory, 'project'); mkdirSync(root);
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
  git(['init', '--quiet']); writeFileSync(join(root, 'code.ts'), 'export const value = 1;\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'base']);
  const baseCommit = git(['rev-parse', 'HEAD']); writeFileSync(join(root, 'code.ts'), 'export const value = 2;\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  return { directory, root, git, input: { root, baseCommit, commit, output: join(directory, 'source.bundle'), maxBytes: 1_048_576, scratch: join(directory, 'scratch') }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
describe('independent source candidate verifier', () => {
  it('native original source image builder and isolated verifier retain exact VM identities for independent task and container absence without changing Git or published image bytes', async ({signal}) => {
    type Phase = 'AUTHORITY' | 'BUILD' | 'DISK' | 'VERIFY' | 'ABSENCE' | 'READBACK' | 'CLOSE';
    let phase: Phase = 'AUTHORITY';
    const started = performance.now();
    const timings: { phase: Phase; elapsedMs: number }[] = [];
    let interrupted: Phase | undefined;
    const capture = () => { interrupted = phase; timings.push({phase,elapsedMs:Math.round(performance.now()-started)}); };
    signal.addEventListener('abort', capture, {once:true});
    const enter = (next: Phase) => { timings.push({phase,elapsedMs:Math.round(performance.now()-started)}); phase=next; };
    // The original Reviewer retains controlled criteria, never arbitrary native
    // assertion values or broker configuration. Keep the original error as well.
    onTestFailed(() => { throw new Error(`ACCEPTANCE_NATIVE_COLD_${interrupted ?? phase}_${signal.aborted ? 'WATCHDOG' : 'FAILURE'}_${timings.map(row=>`${row.phase}_${row.elapsedMs}`).join('_')}: native failure retained`); });
    if (process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0) {
      throw new Error('Existing privileged owning-host authorization required; native builder and verifier cannot be skipped');
    }
    expect(readlinkSync('/proc/self/ns/mnt')).toBe(readlinkSync('/proc/1/ns/mnt'));
    const f = fixture(), brokerPath = '/etc/treeseed/sandbox/broker.json', brokerBytes = readFileSync(brokerPath);
    const configuration = sandboxBrokerConfigurationSchema.parse(JSON.parse(brokerBytes.toString('utf8')));
    const catalog = new WorkspaceCatalog(join(f.directory, 'catalog.db'));
    const bundleRoot = join(workspaceStorageRoot, 'bundles');
    let bundleDirectoryOwned = false;
    let bundlePath: string | undefined, imageId: string | undefined, bundleOwned = false, imageOwned = false, nativeStarted = false;
    let disk: Awaited<ReturnType<typeof createWorkspaceDisk>> | undefined, stopped = false;
    try {
      // Native entrypoints must use their held generated guest siblings, not source
      // import.meta.url paths with nonexistent .js siblings or a test-built replacement.
      const paths = ['workspace-image-builder', 'workspace-candidate-vm', 'workspace-builder-guest', 'workspace-candidate-guest']
        .map(name => new URL(`../dist/src/sandbox/${name}.js`, import.meta.url));
      const heldBuild = paths.map(path => readFileSync(path));
      const builder: typeof import('../src/sandbox/workspace-image-builder.js') = await import(paths[0]!.href);
      const verifier: typeof import('../src/sandbox/workspace-candidate-vm.js') = await import(paths[1]!.href);
      f.git(['branch', 'treeseed-source', f.input.commit]);
      const originalBundle = join(f.directory, 'original.bundle');
      f.git(['bundle', 'create', originalBundle, 'refs/heads/treeseed-source']);
      const bytes = readFileSync(originalBundle), bundleDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      bundlePath = join(workspaceStorageRoot, 'bundles', `${bundleDigest.slice(7)}.bundle`);
      // Only the supplied fixture input needs a bundle directory; ordinary source
      // acquisition creates this directory itself. Never assume prior host traffic.
      try { mkdirSync(bundleRoot, { mode: 0o700 }); bundleDirectoryOwned = true; }
      catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'EEXIST') throw error; }
      // Exclusive creation: this callback must never replace any pre-existing cache input.
      writeFileSync(bundlePath, bytes, { flag: 'wx', mode: 0o400 });
      bundleOwned = true;
      const source = { controlPlaneId: `native-${randomUUID()}`, teamId: 'native-fixture-team', projectId: 'native-fixture-project',
        repositoryId: 'treeseed-ai/sdk', commit: f.input.commit, formatVersion: 1 as const, profile: 'source-only' as const };
      const input = { source, bundleDigest, virtualBytes: 67_108_864 }, held = structuredClone(input);
      imageId = catalog.ensure(source).id;
      // Existing held generated guest entries are required. This case never builds or installs them.
      nativeStarted = true;
      enter('BUILD');
      const built: Record<string, unknown> = { ...await builder.buildWorkspaceImage(configuration, catalog, input) };
      expect(built.imageId).toBe(imageId); expect(built.noop).toBe(false);
      imageOwned = built.imageId === imageId && built.noop === false;
      const imageBytes = readFileSync(workspaceImagePath(imageId)), nativeImage = catalog.image(imageId);
      expect(nativeImage?.state).toBe('ready'); expect(nativeImage?.digest).toBe(built.digest);
      enter('DISK');
      disk = await createWorkspaceDisk(imageId, input.virtualBytes);
      const attached = await attachWorkspaceDisk(disk, true);
      await detachWorkspaceDisk(attached, true);
      // Real guest verifier examines actual Git objects on its read-only native NBD disk.
      enter('VERIFY');
      const verified: Record<string, unknown> = { ...await verifier.candidateVmVerifier(configuration)({
        disk: attached,
        baseCommit: f.input.baseCommit, additionalCommits: [], commit: f.input.commit, maxBytes: f.input.maxBytes,
      }) };
      expect(verified.verifierStopped).toBe(true);
      expect(verified.verification).toMatchObject({ baseCommit: f.input.baseCommit, commit: f.input.commit,
        clean: true, ancestry: true, objectClosure: true, isolatedVerifier: true });
      expect(Array.isArray(built.builderIds)).toBe(true);
      const builderIds = built.builderIds;
      if (!Array.isArray(builderIds)) throw new Error('Native builder identities were discarded; boolean teardown is not physical custody');
      expect(builderIds.length).toBe(2); expect(new Set(builderIds).size).toBe(2);
      expect(typeof verified.verifierId).toBe('string');
      if (typeof verified.verifierId !== 'string') throw new Error('Native verifier identity was discarded');
      const ids: string[] = [];
      for (const id of builderIds) {
        expect(typeof id).toBe('string'); if (typeof id !== 'string') throw new Error('Malformed native builder identity'); ids.push(id);
      }
      ids.push(verified.verifierId); expect(new Set(ids).size).toBe(3);
      expect(verified).not.toHaveProperty('verifierChildId');
      const observe = (kind: 'tasks' | 'containers') => execFileSync('/usr/bin/ctr',
        ['--address', configuration.containerdAddress, '--namespace', configuration.namespace, kind, 'list', '--quiet'],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }).trim().split(/\s+/u).filter(Boolean);
      enter('ABSENCE');
      for (const id of ids) {
        expect(id).toMatch(/^sandbox-warm-[a-f0-9-]{36}$/u);
        for (const kind of ['tasks', 'containers'] as const) {
          const actual = observe(kind);
          for (const resource of [id, `${id}-ready`, `${id}-source`, `${id}-candidate`]) expect(actual).not.toContain(resource);
        }
        expect(existsSync(`/sys/fs/cgroup/treeseed-sandboxes.slice/treeseed-source-${id}.scope`)).toBe(false);
      }
      stopped = true;
      enter('READBACK');
      // Buffer.equals compares every byte and the length without enumerating
      // millions of numeric object keys inside the original native watchdog.
      expect(readFileSync(workspaceImagePath(imageId)).equals(imageBytes)).toBe(true);
      expect(readFileSync(bundlePath)).toEqual(bytes); expect(input).toEqual(held);
      paths.forEach((path, index) => expect(readFileSync(path)).toEqual(heldBuild[index]));
      expect(readFileSync(brokerPath)).toEqual(brokerBytes); expect(f.git(['rev-parse', 'HEAD'])).toBe(f.input.commit);
      expect(f.git(['show', `${f.input.baseCommit}:code.ts`])).toBe('export const value = 1;');
      enter('CLOSE');
    } finally {
      // Only the disposable catalog's exact image and this callback's allocated overlay/bundle are eligible.
      // An uncertain verifier retains its native disk instead of fabricating teardown.
      if (disk && stopped) rmSync(disk.directory, { recursive: true });
      if (imageOwned && imageId && (!disk || stopped) && catalog.claimDeletion(imageId)) {
        rmSync(workspaceImagePath(imageId)); catalog.finishDeletion(imageId);
      }
      catalog.close();
      if (!nativeStarted || stopped) {
        if (bundleOwned && bundlePath) rmSync(bundlePath);
        if (bundleDirectoryOwned && readdirSync(bundleRoot).length === 0) rmdirSync(bundleRoot);
        f.cleanup();
      }
      // Failed native ownership/teardown keeps the allocated catalog and inputs with
      // the uncertain disk; this is an explicit failed quarantine, never a pass.
      signal.removeEventListener('abort',capture);
    }
  }, 30_000);
  it('verifies ancestry, committed work and a portable history bundle', async () => {
    const f = fixture(); try {
      const result = await verifySourceCandidate(f.input); expect(result).toMatchObject({ commit: f.input.commit, baseCommit: f.input.baseCommit, objectClosure: true, ancestry: true, clean: true });
      expect(f.git(['bundle', 'list-heads', f.input.output])).toBe(`${f.input.commit} refs/heads/treeseed-source`);
      const rebuilt = await buildSourceWorkspace({ root: join(f.directory, 'review'), bundle: f.input.output, commit: f.input.commit, parentCommit: null });
      expect(rebuilt).toMatchObject({ commit: f.input.commit, clean: true, objectClosure: true });
    } finally { f.cleanup(); }
  });
  it('never executes guest repository configuration during verification', async () => {
    const f = fixture(); try {
      const marker = join(f.directory, 'executed');
      f.git(['config', 'core.fsmonitor', `touch ${marker}`]);
      f.git(['config', 'core.hooksPath', f.directory]);
      f.git(['config', 'filter.evil.clean', `touch ${marker}`]);
      await verifySourceCandidate(f.input); expect(existsSync(marker)).toBe(false);
    } finally { f.cleanup(); }
  });
  it('rejects uncommitted tracked and untracked work instead of silently losing it', async () => {
    const f = fixture(); try {
      writeFileSync(join(f.root, 'code.ts'), 'uncommitted');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('uncommitted');
      writeFileSync(join(f.root, 'code.ts'), 'export const value = 2;\n'); writeFileSync(join(f.root, 'new.ts'), 'untracked');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('uncommitted');
    } finally { f.cleanup(); }
  });
  it('rejects alternate object stores and output overflow', async () => {
    const f = fixture(); try {
      await expect(verifySourceCandidate({ ...f.input, maxBytes: 1 })).rejects.toThrow('output limit');
      writeFileSync(join(f.root, '.git/objects/info/alternates'), '/elsewhere\n');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('alternates');
    } finally { f.cleanup(); }
  });
  it('rejects a candidate that is not descended from its authorized base', async () => {
    const f = fixture(); try {
      await expect(verifySourceCandidate({ ...f.input, baseCommit: f.input.commit, commit: f.input.baseCommit })).rejects.toThrow();
    } finally { f.cleanup(); }
  });
  it('requires a release integration commit to include every approved predecessor', async () => {
    const f = fixture(); try {
      f.git(['checkout', '-q', f.input.baseCommit]);
      f.git(['checkout', '-qb', 'approved']);
      writeFileSync(join(f.root, 'approved.ts'), 'export const approved = true;\n');
      f.git(['add', '.']); f.git(['commit', '-qm', 'approved']);
      const approved = f.git(['rev-parse', 'HEAD']);
      f.git(['checkout', '-q', f.input.commit]);
      await expect(verifySourceCandidate({ ...f.input, additionalCommits: [approved] })).rejects.toThrow();
      f.git(['merge', '--no-ff', '--no-edit', 'approved']);
      const merged = f.git(['rev-parse', 'HEAD']);
      await expect(verifySourceCandidate({ ...f.input, commit: merged, additionalCommits: [approved] }))
        .resolves.toMatchObject({ commit: merged, ancestry: true });
    } finally { f.cleanup(); }
  });
  it('native verified simulation publication preserves exact candidate bytes through overlapping replay and independent rebuild', async ({signal}) => {
    const f = fixture(), storage = join(f.directory, 'manager');
    let phase = 'INPUT';
    onTestFailed(() => { throw new Error(`ACCEPTANCE_NATIVE_SIMULATION_PUBLICATION_${phase}_${signal.aborted ? 'WATCHDOG' : 'FAILURE'}: original failure retained`); });
    vi.resetModules();
    // Only the fixed private storage location is an allocated test INPUT.
    // The owning publisher, source transport, Git and filesystem remain real.
    vi.doMock('../src/sandbox/workspace-block-store.js', () => ({ workspaceStorageRoot: storage }));
    try {
      const { publishVerifiedSourceBranch } = await import('../src/sandbox/source-branch-publication.js');
      const now = new Date();
      const response: SourceWorkspaceResponse = { authorization: {
        schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
        source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'treeseed-ai/sdk',
          commit: f.input.baseCommit, formatVersion: 1, profile: 'source-only' },
        mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch',
        publicationRef: 'simulation/campaign/workday/assignment', issuedAt: now.toISOString(), expiresAt: new Date(+now + 30_000).toISOString(),
      }, repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: 'staging' }, credential: null };
      const before = structuredClone(response), base = f.git(['show', `${f.input.baseCommit}:code.ts`]);
      const candidateBytes = readFileSync(join(f.root, 'code.ts'));
      phase = 'VERIFY';
      await verifySourceCandidate(f.input);
      const bundle = readFileSync(f.input.output), input = { assignmentId: 'assignment', attempt: 1, commit: f.input.commit, bundlePath: f.input.output, response };
      const expected = { kind: 'git', repository: 'treeseed-ai/sdk', commit: f.input.commit, branch: response.authorization.publicationRef };
      phase = 'PUBLISH';
      expect(await Promise.allSettled([publishVerifiedSourceBranch(input), publishVerifiedSourceBranch(input)]))
        .toEqual([{status:'fulfilled',value:expected},{status:'fulfilled',value:expected}]);
      expect(await publishVerifiedSourceBranch(input)).toEqual(expected);
      const repository = simulationSourceRepository(storage, response.authorization.source);
      const git = (args: string[]) => execFileSync('/usr/bin/git', ['--git-dir', repository, ...args],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      const refs = git(['for-each-ref', '--format=%(refname) %(objectname)']);
      expect(refs).toBe(`refs/heads/${expected.branch} ${expected.commit}\n`);
      phase = 'REPLAY';
      const attempts = await Promise.allSettled([publishVerifiedSourceBranch(input), publishVerifiedSourceBranch(input)]);
      expect(attempts).toEqual([{ status: 'fulfilled', value: expected }, { status: 'fulfilled', value: expected }]);
      expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refs);
      expect(git(['rev-parse', '--verify', `refs/heads/${expected.branch}^{commit}`]).trim()).toBe(f.input.commit);
      expect(Buffer.from(git(['show', `${f.input.commit}:code.ts`]))).toEqual(candidateBytes);
      expect(git(['merge-base', '--is-ancestor', f.input.baseCommit, f.input.commit])).toBe('');
      phase = 'CONFIG_LOCK_REPLAY';
      const config = readFileSync(join(repository, 'config')), lock = Buffer.from('retained unrelated native writer\n');
      writeFileSync(join(repository, 'config.lock'), lock, {flag:'wx'});
      expect(await publishVerifiedSourceBranch(input)).toEqual(expected);
      expect(readFileSync(join(repository, 'config'))).toEqual(config);
      expect(readFileSync(join(repository, 'config.lock'))).toEqual(lock);
      rmSync(join(repository, 'config.lock'));
      phase = 'REBUILD';
      const rebuilt = await buildSourceWorkspace({ root: join(f.directory, 'independent-review'), bundle: f.input.output, commit: f.input.commit, parentCommit: null });
      expect(rebuilt).toMatchObject({ commit: f.input.commit, clean: true, objectClosure: true });
      expect(readFileSync(join(f.directory, 'independent-review/code.ts'))).toEqual(candidateBytes);
      expect(readFileSync(f.input.output)).toEqual(bundle);
      expect(createHash('sha256').update(readFileSync(f.input.output)).digest('hex')).toBe(createHash('sha256').update(bundle).digest('hex'));
      expect(f.git(['show', `${f.input.baseCommit}:code.ts`])).toBe(base); expect(f.git(['rev-parse', 'HEAD'])).toBe(f.input.commit);
      expect(response).toEqual(before); expect(readdirSync(join(storage, 'publications'))).toEqual([]);
    } finally { vi.doUnmock('../src/sandbox/workspace-block-store.js'); vi.resetModules(); f.cleanup(); }
  });
  it('native missing corrupt and competing simulation publications retain the original ref failed input bytes and allocated-directory cleanup', async () => {
    const f = fixture(), storage = join(f.directory, 'manager');
    vi.resetModules(); vi.doMock('../src/sandbox/workspace-block-store.js', () => ({ workspaceStorageRoot: storage }));
    try {
      const { publishVerifiedSourceBranch } = await import('../src/sandbox/source-branch-publication.js');
      const now = new Date(), response: SourceWorkspaceResponse = { authorization: {
        schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
        source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'treeseed-ai/sdk', commit: f.input.baseCommit, formatVersion: 1, profile: 'source-only' },
        mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch', publicationRef: 'simulation/campaign/workday/assignment',
        issuedAt: now.toISOString(), expiresAt: new Date(+now + 30_000).toISOString(),
      }, repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: 'staging' }, credential: null };
      const before = structuredClone(response); await verifySourceCandidate(f.input);
      const bundle = readFileSync(f.input.output), input = { assignmentId: 'assignment', attempt: 1, commit: f.input.commit, bundlePath: f.input.output, response };
      const expected = await publishVerifiedSourceBranch(input), repository = simulationSourceRepository(storage, response.authorization.source);
      const git = (args: string[]) => execFileSync('/usr/bin/git', ['--git-dir', repository, ...args],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      const refs = git(['for-each-ref', '--format=%(refname) %(objectname)']);
      const corrupt = join(f.directory, 'corrupt.bundle'), corruptBytes = Buffer.from('not a Git bundle\n'); writeFileSync(corrupt, corruptBytes);
      const missing = join(f.directory, 'absent.bundle');
      for (const bundlePath of [missing, corrupt]) {
        await expect(publishVerifiedSourceBranch({ ...input, bundlePath })).rejects.toThrow();
        expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refs);
        expect(existsSync(missing)).toBe(false); expect(readFileSync(corrupt)).toEqual(corruptBytes);
        expect(readFileSync(f.input.output)).toEqual(bundle); expect(readdirSync(join(storage, 'publications'))).toEqual([]);
      }
      writeFileSync(join(f.root, 'code.ts'), 'export const value = 3;\n'); f.git(['add', '.']); f.git(['commit', '-qm', 'competing candidate']);
      const competingCommit = f.git(['rev-parse', 'HEAD']), competing = { ...f.input, commit: competingCommit,
        output: join(f.directory, 'competing.bundle'), scratch: join(f.directory, 'competing-scratch') };
      await verifySourceCandidate(competing); const competingBytes = readFileSync(competing.output);
      await expect(publishVerifiedSourceBranch({ ...input, commit: competingCommit, bundlePath: competing.output })).rejects.toThrow('already identifies another commit');
      expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refs);
      expect(readFileSync(competing.output)).toEqual(competingBytes); expect(readFileSync(f.input.output)).toEqual(bundle);
      expect(response).toEqual(before); expect(await publishVerifiedSourceBranch(input)).toEqual(expected);
      expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refs);
      expect(readdirSync(join(storage, 'publications'))).toEqual([]);
      // Objects imported before the ref-conflict denial may remain; only the
      // authorized original ref and failed inputs are claimed immutable.
    } finally { vi.doUnmock('../src/sandbox/workspace-block-store.js'); vi.resetModules(); f.cleanup(); }
  });
});
