import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { acquireSourceBundle, type SourceGitCacheDependencies } from '../src/sandbox/source-git-cache.js';
import { runSourceGit, sourceGitCommand } from '../src/sandbox/source-git-transport.js';

const roots: string[] = [];
const volume: SourceGitCacheDependencies['volume'] = async (cache, _limit, action) => action(cache);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = new Date('2026-09-10T23:00:00.000Z');
const authorization: SourceWorkspaceAuthorization = {
  schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
  source: { controlPlaneId: 'control-plane', teamId: 'team', projectId: 'project', repositoryId: 'repository', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
  mode: 'analysis', publication: 'denied', credentialBindingId: 'binding', issuedAt: now.toISOString(), expiresAt: '2026-09-11T00:00:00.000Z',
};
const input = { authorization, repository: { owner: 'example', name: 'project', cloneUrl: 'https://github.com/example/project.git' }, credential: { username: 'x-access-token', token: 'synthetic-source-token' }, maxBundleBytes: 1_048_576 };

describe('trusted source acquisition', () => {
  it('keeps credentials out of argv/config and excludes ambient configuration', () => {
    const command = sourceGitCommand('/managed/repository.git', ['fetch', input.repository.cloneUrl, authorization.source.commit], input.credential);
    expect(JSON.stringify(command.args)).not.toContain(input.credential.token);
    expect(command.args).toContain('credential.helper=');
    expect(command.args).toContain('http.followRedirects=false');
    expect(command.args).toContain('protocol.allow=never');
    expect(command.args).toContain('core.hooksPath=/dev/null');
    expect(command.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(command.env.TREESEED_SOURCE_GIT_HEADER).toMatch(/^Authorization: Basic /u);
    expect(sourceGitCommand('/managed/repository.git', ['fsck']).env.TREESEED_SOURCE_GIT_HEADER).toBeUndefined();
  });

  it('rejects noncanonical repository, expired authorization, and invalid quota before storage access', async () => {
    const dependencies = { root: '/unused', initialize: vi.fn(), run: vi.fn(), now: () => now, volume };
    for (const candidate of [
      { ...input, repository: { ...input.repository, cloneUrl: 'http://169.254.169.254/' } },
      { ...input, authorization: { ...authorization, issuedAt: '2026-09-09T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z' } },
      { ...input, maxBundleBytes: -1 },
    ]) await expect(acquireSourceBundle(candidate, dependencies)).rejects.toThrow();
    expect(dependencies.initialize).not.toHaveBeenCalled();
  });

  it('fetches exact full history into a manager cache, emits an immutable bundle and reauthorizes replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'treeseed-source-cache-test-')); roots.push(root);
    const fixture = join(root, 'fixture'); await mkdir(fixture);
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', fixture, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
    git(['init', '-q', '--template=']); await writeFile(join(fixture, 'source.ts'), 'export const value = 1;\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    await writeFile(join(fixture, 'source.ts'), 'export const value = 2;\n'); git(['commit', '-qam', 'next']); const commit = git(['rev-parse', 'HEAD']);
    const fetches = vi.fn();
    const dependencies: SourceGitCacheDependencies = {
      root, initialize: async () => {}, now: () => now, volume,
      run: async (repository, args, credential) => {
        if (args[0] === 'fetch') {
          fetches(credential);
          // Test-only transport replaces the network with this synthetic repository; production never allows file://.
          return execFileSync('/usr/bin/git', ['--git-dir', repository, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', fixture, String(args.at(-1))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        }
        return runSourceGit(repository, args, credential);
      },
    };
    const request = { ...input, authorization: { ...authorization, source: { ...authorization.source, commit } } };
    const result = await acquireSourceBundle(request, dependencies);
    const replay = await acquireSourceBundle(request, dependencies);
    expect(replay).toEqual(result); expect(fetches).toHaveBeenCalledTimes(2);
    const cache = join(root, 'git', result.cacheId, 'repository.git');
    expect(await runSourceGit(cache, ['rev-list', '--count', commit])).toBe('2');
    expect(await runSourceGit(cache, ['merge-base', '--is-ancestor', base, commit])).toBe('');
    expect(await readFile(join(cache, 'config'), 'utf8')).not.toMatch(/synthetic-source-token|extraHeader|remote /u);
    expect((await readdir(join(root, 'bundles')))).toHaveLength(1);
    expect(await readFile(join(root, 'bundles', `${result.bundleDigest.slice(7)}.bundle`))).not.toContain(Buffer.from(input.credential.token));
    await expect(acquireSourceBundle(request, { ...dependencies, now: () => new Date('2026-09-12T00:00:00Z') })).rejects.toThrow('expired');
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it('leaves an uncertain acquisition fenced rather than stealing or deleting its work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'treeseed-source-cache-test-')); roots.push(root);
    const dependencies = { root, initialize: async () => {}, now: () => now, volume, run: vi.fn(async () => { throw new Error('uncertain child'); }) };
    await expect(acquireSourceBundle(input, dependencies)).rejects.toThrow('uncertain child');
    await expect(acquireSourceBundle(input, dependencies)).rejects.toThrow('awaiting recovery');
    expect(dependencies.run).toHaveBeenCalledTimes(1);
  });
});
