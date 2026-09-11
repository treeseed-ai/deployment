import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const exact = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Run ONLY inside a fresh, network-denied verifier VM with the executed disk mounted read-only.
 * Never use the execution repository's config, hooks or index: even `git status` can execute fsmonitor/filter commands. */
export async function verifySourceCandidate(input: { root: string; baseCommit: string; commit: string; output: string; maxBytes: number; scratch: string }) {
  if (!exact.test(input.baseCommit) || !exact.test(input.commit) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error('Candidate verification input is invalid.');
  const metadata = join(input.root, '.git'), objects = join(metadata, 'objects');
  for (const directory of [input.root, metadata, objects]) {
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Candidate Git objects escaped the isolated source mount.');
  }
  const alternates = await lstat(join(objects, 'info', 'alternates')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (alternates) throw new Error('Candidate object alternates are forbidden.');
  await mkdir(input.scratch, { recursive: true });
  const clean = await mkdtemp(join(input.scratch, 'candidate-verifier-'));
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['--git-dir', clean, ...(args[0] === 'init' ? [] : ['--work-tree', input.root]),
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'protocol.allow=never', '-c', 'core.autocrlf=false', ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })).stdout.trim();
  try {
    await git(['init', '--bare', '--template=']);
    await writeFile(join(clean, 'objects/info/alternates'), `${objects}\n`);
    await mkdir(join(clean, 'info'), { recursive: true });
    await writeFile(join(clean, 'info/exclude'), '/lost+found\n');
    if (await git(['rev-parse', `${input.commit}^{commit}`]) !== input.commit) throw new Error('Candidate object is not an exact commit.');
    await git(['fsck', '--strict', '--no-reflogs', '--no-dangling', input.commit]);
    await git(['merge-base', '--is-ancestor', input.baseCommit, input.commit]);
    await git(['update-ref', 'refs/heads/treeseed-candidate', input.commit]);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/treeseed-candidate']);
    await git(['read-tree', input.commit]);
    if (await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Candidate workspace has uncommitted changes.');
    // One named commit history only: never export guest branches, refs, hooks, configuration or credentials.
    await git(['bundle', 'create', input.output, 'refs/heads/treeseed-candidate']);
    const file = await lstat(input.output);
    if (!file.isFile() || file.size < 1 || file.size > input.maxBytes) throw new Error('Candidate bundle exceeds its authorized output limit.');
    await git(['bundle', 'verify', input.output]);
    return { baseCommit: input.baseCommit, commit: input.commit, bytes: file.size, clean: true as const,
      objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const };
  } finally { await rm(clean, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(await readFile('/run/treeseed-verifier/candidate.json', 'utf8')) as { baseCommit: string; commit: string; maxBytes: number };
    const receipt = await verifySourceCandidate({ ...input, root: '/workspace/project', output: '/run/treeseed-output/source.bundle', scratch: '/tmp' });
    await writeFile('/run/treeseed-output/candidate-verification.json', JSON.stringify(receipt));
  } catch {
    await writeFile('/run/treeseed-output/candidate-verification.json', JSON.stringify({ failed: true }));
    process.exitCode = 1;
  }
}
