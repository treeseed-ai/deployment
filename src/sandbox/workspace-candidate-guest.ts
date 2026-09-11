import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const exact = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const environment = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** Stream a full bundle with a strict write ceiling instead of letting Git fill the output volume first. */
async function writeBoundedBundle(args: string[], path: string, maximum: number) {
  const file = await open(path, 'wx', 0o600), child = spawn('/usr/bin/git', args, { env: environment, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  void exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000); let bytes = 0;
  try {
    for await (const data of child.stdout) {
      const chunk = Buffer.from(data as Uint8Array); bytes += chunk.length;
      if (bytes > maximum) throw new Error('Candidate bundle exceeds its authorized output limit.');
      let offset = 0;
      while (offset < chunk.length) { const result = await file.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new Error('Candidate output write failed.'); offset += result.bytesWritten; }
    }
    if (await exited !== 0) throw new Error('Candidate bundle creation failed.');
    await file.sync();
  } finally { child.kill('SIGKILL'); await exited.catch(() => undefined); clearTimeout(timer); await file.close(); }
}

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
  const gitArgs = (args: string[]) => ['--git-dir', clean, ...(args[0] === 'init' ? [] : ['--work-tree', input.root]),
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'protocol.allow=never', '-c', 'core.autocrlf=false', ...args];
  const git = async (args: string[]) => (await exec('/usr/bin/git', gitArgs(args), {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576,
    env: environment,
  })).stdout.trim();
  try {
    await git(['init', '--bare', '--template=']);
    await writeFile(join(clean, 'objects/info/alternates'), `${objects}\n`);
    await mkdir(join(clean, 'info'), { recursive: true });
    await writeFile(join(clean, 'info/exclude'), '/lost+found\n');
    if (await git(['rev-parse', `${input.commit}^{commit}`]) !== input.commit) throw new Error('Candidate object is not an exact commit.');
    await git(['fsck', '--strict', '--no-reflogs', '--no-dangling', input.commit]);
    await git(['merge-base', '--is-ancestor', input.baseCommit, input.commit]);
    await git(['update-ref', 'refs/heads/treeseed-source', input.commit]);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/treeseed-source']);
    await git(['read-tree', input.commit]);
    if (await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Candidate workspace has uncommitted changes.');
    // One named commit history only: never export guest branches, refs, hooks, configuration or credentials.
    await writeBoundedBundle(gitArgs(['bundle', 'create', '-', 'refs/heads/treeseed-source']), input.output, input.maxBytes);
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
