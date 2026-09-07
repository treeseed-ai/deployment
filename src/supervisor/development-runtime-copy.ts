import { createHash } from 'node:crypto';
import { chmodSync, constants, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Copy code only. No source-owned command executes in the supervisor. */
export function copyDevelopmentRuntime(input: { worktree: string; workspace: string; destination: string; sourceUid: number }) {
  const workspace = realpathSync(input.workspace);
  const destination = resolve(input.destination);
  const digest = createHash('sha256');
  let files = 0, bytes = 0, entries = 0;
  const within = (path: string) => path === workspace || path.startsWith(workspace + sep);
  if (within(destination)) throw new Error('Candidate custody must be outside the source workspace.');
  // The containing manager directory remains 0700; code is readable inside
  // the bind mount by either a root or nonroot installed runtime identity.
  mkdirSync(destination, { mode: 0o755 });
  chmodSync(destination, 0o755);
  const copy = (source: string, target: string, ancestors: Set<string>) => {
    if (++entries > 200_000 || ancestors.size > 128) throw new Error('Candidate runtime exceeds custody limits.');
    // Inspect the opened object, not a path checked before a possible symlink swap.
    const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const actual = realpathSync(`/proc/self/fd/${fd}`), stat = fstatSync(fd);
      if (!within(actual) || stat.uid !== input.sourceUid)
        throw new Error('Candidate dependency escaped operator-owned workspace custody.');
      if (stat.isDirectory()) {
        if (ancestors.has(actual)) throw new Error('Candidate dependency contains a directory cycle.');
        const next = new Set(ancestors).add(actual);
        mkdirSync(target, { mode: 0o755 });
        chmodSync(target, 0o755);
        for (const name of readdirSync(`/proc/self/fd/${fd}`).sort())
          copy(`/proc/self/fd/${fd}/${name}`, resolve(target, name), next);
      } else {
        // npm uses hardlinks for binaries. Copy their bytes into new private
        // files; never retain hardlinks to the operator's mutable cache.
        if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
          throw new Error('Candidate dependency is not a bounded regular file.');
        bytes += stat.size;
        if (++files > 100_000 || bytes > 2 * 1024 ** 3) throw new Error('Candidate runtime exceeds custody limits.');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0, count = 0;
        while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
        if (length !== stat.size) throw new Error('Candidate dependency changed during materialization.');
        const data = buffer.subarray(0, length);
        const name = target.slice(destination.length + 1);
        digest.update(JSON.stringify([name, data.length, stat.mode & 0o111])).update(data);
        writeFileSync(target, data, { flag: 'wx', mode: stat.mode & 0o111 ? 0o755 : 0o644 });
        chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
      }
    } finally { closeSync(fd); }
  };
  try {
    for (const name of ['package.json', 'dist', 'node_modules', 'drizzle'])
      copy(resolve(input.worktree, name), resolve(destination, name), new Set());
  } catch (error) {
    // Only our freshly-created private candidate is removed; never source data.
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { files, bytes, digest: `sha256:${digest.digest('hex')}` };
}
