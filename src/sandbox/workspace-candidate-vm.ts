import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { attachWorkspaceDisk, detachWorkspaceDisk, workspaceStorageRoot, type WorkspaceDisk } from './workspace-block-store.js';
import { containerdImageReference } from './image-reference.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { kataWarmOperations } from './warm-sandbox-pool.js';
import type { CandidateOperations, CandidateVerification } from './workspace-candidate.js';

const exec = promisify(execFile);

/** Fresh verifier VM, read-only executed disk, no network, credentials, or execution input mount. */
export function candidateVmVerifier(configuration: SandboxBrokerConfiguration): CandidateOperations['verify'] {
  return async input => {
    if (!/^workspace-lease-[a-f0-9-]{36}$/u.test(input.disk.id)
      || input.disk.directory !== join(workspaceStorageRoot, 'leases', input.disk.id)
      || input.disk.image !== join(input.disk.directory, 'work.qcow2')) throw new Error('Candidate disk escaped manager custody.');
    const configured = configuration.guestImages[0];
    if (!configured) throw new Error('Candidate verification requires a trusted guest image.');
    const directory = await mkdtemp(join(input.disk.directory, 'candidate-'));
    const incoming = join(directory, 'input'), outgoing = join(directory, 'output');
    for (const path of [incoming, outgoing]) { await mkdir(path, { mode: 0o700 }); await chown(path, 65532, 65532); }
    await copyFile(fileURLToPath(new URL('./workspace-candidate-guest.js', import.meta.url)), join(incoming, 'verifier.mjs'));
    await writeFile(join(incoming, 'candidate.json'), JSON.stringify({ baseCommit: input.baseCommit, commit: input.commit, maxBytes: input.maxBytes }));
    for (const name of ['verifier.mjs', 'candidate.json']) { await chmod(join(incoming, name), 0o400); await chown(join(incoming, name), 65532, 65532); }
    const image = containerdImageReference(configured.image, configured.digest);
    const operations = kataWarmOperations(configuration, () => undefined);
    const ctr = async (args: string[]) => (await exec('/usr/bin/ctr', ['--address', configuration.containerdAddress,
      '--namespace', configuration.namespace, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout;
    let attached: WorkspaceDisk | undefined, vm: string | undefined, child: string | undefined, stopped = false;
    try {
      attached = await attachWorkspaceDisk(input.disk, true);
      vm = await operations.create({ image, cpuCores: 1, memoryBytes: 1_073_741_824, network: 'none' });
      child = `${vm}-candidate`;
      await ctr(['run', '--rm', '--null-io', '--runtime', configuration.runtime,
        '--label', 'io.kubernetes.cri.container-type=container', '--label', `io.kubernetes.cri.sandbox-id=${vm}`,
        '--user', '65532:65532',
        '--mount', `type=bind,src=${attached.device},dst=/workspace/project,options=ro:nodev:nosuid`,
        '--mount', `type=bind,src=${incoming},dst=/run/treeseed-verifier,options=rbind:ro`,
        '--mount', `type=bind,src=${outgoing},dst=/run/treeseed-output,options=rbind:rw`,
        image, child, 'node', '/run/treeseed-verifier/verifier.mjs']);
    } finally {
      if (vm) {
        await operations.destroy(vm);
        if (child) {
          await ctr(['tasks', 'delete', '--force', child]).catch(() => undefined);
          await ctr(['containers', 'delete', child]).catch(() => undefined);
          if ((await ctr(['tasks', 'list', '--quiet'])).split(/\s+/u).includes(child)
            || (await ctr(['containers', 'list', '--quiet'])).split(/\s+/u).includes(child)) throw new Error('Candidate verifier teardown is uncertain; source is retained.');
        }
        stopped = true;
      }
      // Failed VM creation may leave uncertain resources; retain the device fence in that case.
      if (attached && stopped) await detachWorkspaceDisk(attached, true);
    }
    const receiptPath = join(outgoing, 'candidate-verification.json');
    const details = await lstat(receiptPath);
    if (!details.isFile() || details.size > 8192 || await realpath(receiptPath) !== receiptPath) throw new Error('Invalid candidate verification receipt.');
    const verification = JSON.parse(await readFile(receiptPath, 'utf8')) as CandidateVerification;
    const bundlePath = join(outgoing, 'source.bundle');
    const handle = await open(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > input.maxBytes
        || info.size !== verification.bytes) throw new Error('Candidate bundle is invalid or exceeds its limit.');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      await handle.sync();
    } finally { await handle.close(); }
    await chown(bundlePath, 0, 0); await chmod(bundlePath, 0o400);
    const parent = await open(outgoing, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    return { verification, bundlePath, digest: `sha256:${hash.digest('hex')}`, verifierStopped: stopped };
  };
}
