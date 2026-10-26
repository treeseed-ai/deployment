import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

it('native broker signal handling closes actual listeners once and preserves failed warm teardown and retained work', async () => {
  for (const mode of ['success', 'fail']) {
    const root = await mkdtemp(join(tmpdir(), 'native-broker-signal-'));
    let child: ChildProcess | undefined;
    try {
      child = fork(fileURLToPath(new URL('./support/sandbox-broker-signal.ts', import.meta.url)), [root, mode],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = ''; child.stderr!.on('data', bytes => { stderr += String(bytes); });
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child!.once('error', reject); child!.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const ports = await new Promise<number[]>((resolve, reject) => {
        child!.on('message', value => {
          if (!value || typeof value !== 'object') return;
          if (Reflect.get(value, 'type') === 'ready') { resolve(Reflect.get(value, 'ports') as number[]); child!.kill('SIGTERM'); }
          if (Reflect.get(value, 'type') === 'draining') child!.kill('SIGTERM');
        });
        child!.once('exit', () => reject(new Error(`Broker exited before ready: ${stderr.slice(0, 400)}`)));
      });
      expect(await done).toEqual({ code: mode === 'fail' ? 1 : 0, signal: null });
      expect(JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'))).toEqual({ signals: 2, destroys: 1 });
      expect(await readFile(join(root, 'retained-work'), 'utf8')).toBe('original retained work');
      if (mode === 'fail') { expect(await readFile(join(root, 'pristine'), 'utf8')).toBe('owned pristine capacity'); expect(stderr).toContain('shutdown-failed'); }
      else { await expect(access(join(root, 'pristine'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(stderr).toBe(''); }
      for (const port of ports) await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); reject(new Error('Native broker listener remains open')); });
        socket.once('error', error => { expect(error).toMatchObject({ code: 'ECONNREFUSED' }); resolve(); });
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 20_000);
