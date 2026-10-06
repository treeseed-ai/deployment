import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWorkspaceDisk, detachWorkspaceDisk, workspaceStorageRoot, type WorkspaceDisk } from './workspace-block-store.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { runWorkspaceGuest } from './workspace-image-builder.js';
import type { CandidateOperations, CandidateVerification } from './workspace-candidate.js';

/** Fresh verifier VM, read-only executed disk, no network, credentials, or execution input mount. */
export function candidateVmVerifier(configuration: SandboxBrokerConfiguration): CandidateOperations['verify'] {
  return async input => {
    if (!/^workspace-lease-[a-f0-9-]{36}$/u.test(input.disk.id)
      || input.disk.directory !== join(workspaceStorageRoot, 'leases', input.disk.id)
      || input.disk.image !== join(input.disk.directory, 'work.qcow2')) throw new Error('Candidate disk escaped manager custody.');
    const directory = await mkdtemp(join(input.disk.directory, 'candidate-'));
    const incoming = join(directory, 'input'), outgoing = join(directory, 'output');
    for (const path of [incoming, outgoing]) { await mkdir(path, { mode: 0o700 }); await chown(path, 65532, 65532); }
    await copyFile(fileURLToPath(new URL('./workspace-candidate-guest.js', import.meta.url)), join(incoming, 'verifier.mjs'));
    await writeFile(join(incoming, 'candidate.json'), JSON.stringify({ baseCommit: input.baseCommit,
      additionalCommits: input.additionalCommits, commit: input.commit, maxBytes: input.maxBytes }));
    for (const name of ['verifier.mjs', 'candidate.json']) { await chmod(join(incoming, name), 0o400); await chown(join(incoming, name), 65532, 65532); }
    let attached: WorkspaceDisk | undefined, vm: string | undefined, stopped = false, executionError: unknown;
    try {
      attached = await attachWorkspaceDisk(input.disk, true);
      vm = `sandbox-warm-${randomUUID()}`;
      executionError = await runWorkspaceGuest(configuration, { id: vm, device: attached.device,
        incoming, outgoing, entry: 'verifier.mjs', readOnly: true });
      stopped = true;
    } catch (error) {
      executionError = error;
    } finally {
      // Failed VM creation may leave uncertain resources; retain the device fence in that case.
      if (attached && stopped) await detachWorkspaceDisk(attached, true);
    }
    const receiptPath = join(outgoing, 'candidate-verification.json');
    const details = await lstat(receiptPath).catch(() => { throw executionError ?? new Error('Candidate verifier omitted its receipt.'); });
    if (!details.isFile() || details.size > 8192 || await realpath(receiptPath) !== receiptPath) throw new Error('Invalid candidate verification receipt.');
    const parsed = JSON.parse(await readFile(receiptPath, 'utf8')) as CandidateVerification | { failed: true; reason?: string };
    if ('failed' in parsed) throw new Error(`Candidate verifier rejected source: ${parsed.reason ?? 'unspecified verifier failure'}`);
    if (executionError) throw executionError;
    const verification = parsed;
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
    if (!vm) throw new Error('Candidate verifier ownership was not retained.');
    return { verification, bundlePath, digest: `sha256:${hash.digest('hex')}`, verifierStopped: stopped,
      verifierId: vm };
  };
}
