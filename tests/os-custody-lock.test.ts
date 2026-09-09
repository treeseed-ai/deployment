import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { withOsCustodyLock } from '../src/security/custody/os-lock.js';

it('serializes overlapping exchanges on one custody without stale lock files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-custody-lock-')), sequence: string[] = [];
  try {
    let entered!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const first = withOsCustodyLock(root, async () => { sequence.push('first-start'); entered(); await delay(30); sequence.push('first-end'); });
    await firstEntered;
    await Promise.all([first, withOsCustodyLock(root, async () => { sequence.push('second'); })]);
    expect(sequence).toEqual(['first-start', 'first-end', 'second']);
    await expect(withOsCustodyLock(root, async () => { throw new Error('callback failed'); })).rejects.toThrow('callback failed');
    expect(await withOsCustodyLock(root, async () => 'released')).toBe('released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('kernel releases a killed lock holder without deleting or stealing a PID lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-custody-lock-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await withOsCustodyLock(root, async () => undefined);
    child = spawn('/usr/bin/flock', ['--no-fork', '--exclusive', join(root, 'transaction.lock'), '/usr/bin/cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const ready = once(child.stdout!, 'data'); child.stdin!.write('ready\n'); await ready;
    let entered = false;
    const waiting = withOsCustodyLock(root, async () => { entered = true; });
    await delay(30); expect(entered).toBe(false);
    child.kill('SIGKILL'); await waiting; expect(entered).toBe(true);
  } finally { child?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
it('rejects unsafe lock inodes and invalid timeouts before executing callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-custody-lock-'));
  try {
    writeFileSync(join(root, 'target'), '', { mode: 0o600 }); symlinkSync(join(root, 'target'), join(root, 'transaction.lock'));
    await expect(withOsCustodyLock(root, async () => { throw new Error('must not run'); })).rejects.toThrow();
    await expect(withOsCustodyLock(root, async () => true, 0)).rejects.toThrow('timeout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
