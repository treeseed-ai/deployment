import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandboxBroker } from '../src/sandbox/server.js';
import { installSandboxBrokerShutdown } from '../src/sandbox/broker-shutdown.js';

const state = vi.hoisted(() => ({ root: '', created: 0, closed: 0, drain: vi.fn(async () => undefined) }));
vi.mock('../src/sandbox/configuration.js', () => ({ loadSandboxBrokerConfiguration: () => ({
  socketPath: join(state.root, 'broker.sock'), relay: { port: 0, listenHost: '127.0.0.1', certificateFile: join(state.root, 'cert'), privateKeyFile: join(state.root, 'key') },
}) }));
vi.mock('../src/sandbox/runtime.js', () => ({ KataSandboxRuntime: class {
  reconcile() { return { reconciled: true }; }
  drainWarmPool() { return state.drain(); }
} }));
vi.mock('../src/sandbox/workspace-build-recovery.js', () => ({ recoverWorkspaceBuilds: async () => undefined }));
async function network(original: () => Promise<unknown>) {
  const actual = await original() as Record<string, unknown>, { EventEmitter } = await import('node:events');
  return { ...actual, createServer: () => {
    state.created++;
    return new class extends EventEmitter {
      listen() { return this; }
      close(callback?: (error?: Error) => void) { state.closed++; callback?.(); return this; }
      closeIdleConnections() {}
    }();
  } };
}
vi.mock('node:http', async original => network(original));
vi.mock('node:https', async original => network(original));
afterEach(async () => { vi.restoreAllMocks(); if (state.root) await rm(state.root, { recursive: true, force: true }); state.root = ''; });

it('normal broker termination stops every listener and drains its pristine warm pool once across repeated signals', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'broker-shutdown-')); state.created = 0; state.closed = 0; state.drain.mockClear();
  await writeFile(join(state.root, 'cert'), 'unit TLS input'); await writeFile(join(state.root, 'key'), 'unit TLS input');
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') handlers.set(event, listener as () => void);
    return process;
  });
  await startSandboxBroker(); expect(state.created).toBe(3);
  expect(handlers.has('SIGTERM')).toBe(true); expect(handlers.has('SIGINT')).toBe(true);
  handlers.get('SIGTERM')!(); handlers.get('SIGTERM')!(); handlers.get('SIGINT')!();
  await vi.waitFor(() => { expect(state.closed).toBe(3); expect(state.drain).toHaveBeenCalledTimes(1); });
});

it('retains every shutdown error while still closing all listeners and removing signal hooks', async () => {
  for (const mode of ['listener', 'idle', 'drain']) {
    const original = new Error(`original ${mode} failure`), before = process.listenerCount('SIGTERM');
    let closed = 0, idle = 0, drained = 0;
    const servers = Array.from({ length: 3 }, (_, index) => ({
      close(callback: (error?: Error) => void) { closed++; callback(mode === 'listener' && index === 0 ? original : undefined); },
      closeIdleConnections() { idle++; if (mode === 'idle' && index === 0) throw original; },
    }));
    const close = installSandboxBrokerShutdown(servers, async () => { drained++; if (mode === 'drain') throw original; });
    const first = close(); expect(close()).toBe(first);
    await expect(first).rejects.toMatchObject({ message: 'Sandbox broker shutdown failed.', errors: [original] });
    expect({ closed, idle, drained }).toEqual({ closed: 3, idle: 3, drained: 1 }); expect(process.listenerCount('SIGTERM')).toBe(before);
  }
});
