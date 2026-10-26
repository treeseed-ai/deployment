import { beforeEach, expect, it, vi } from 'vitest';
import { brokerCgroupEmpty } from '../src/sandbox/workspace-collection.js';

const observed = vi.hoisted(() => ({ group: '', pid: '0', state: 'inactive', slice: 'system.slice', rootMissing: false, childMissing: false, controllersMissing: false, processAlive: false }));
const absent = () => Object.assign(new Error('Missing observed path'), { code: 'ENOENT' });
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: async (_command: string, args: string[]) =>
    ({ stdout: args.includes('--property=MainPID') ? observed.pid : args.includes('--property=ActiveState') ? observed.state
      : args.includes('--property=Slice') ? observed.slice : observed.group }) });
  return { ...actual, execFile };
});
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  readFile: async (path: string) => {
    if (path.startsWith('/proc/')) { if (observed.processAlive) return 'live process'; throw absent(); }
    if (path === '/sys/fs/cgroup/cgroup.controllers') { if (observed.controllersMissing) throw absent(); return 'cpu memory'; }
    if (observed.rootMissing || observed.childMissing && path.includes('/child/')) throw absent();
    return '';
  },
  lstat: async () => { if (observed.rootMissing) throw absent(); return { isDirectory: () => true }; },
  readdir: async () => observed.childMissing ? [{ name: 'child', isDirectory: () => true }] : [],
}));

const original = { pid: 42, cgroup: '/system.slice/treeseed-sandbox-broker.service' };
beforeEach(() => Object.assign(observed, { group: '', pid: '0', state: 'inactive', slice: 'system.slice', rootMissing: false, childMissing: false, controllersMissing: false, processAlive: false }));
it('recognizes the original stopped cgroup when systemd clears ControlGroup', async () => {
  expect(await brokerCgroupEmpty(original)).toBe(true);
});
it('requires the original process gone, matching reported identity and a known group', async () => {
  observed.processAlive = true; expect(await brokerCgroupEmpty(original)).toBe(false);
  observed.processAlive = false; observed.group = '/system.slice/foreign.service'; expect(await brokerCgroupEmpty(original)).toBe(false);
  observed.group = ''; observed.state = 'active'; expect(await brokerCgroupEmpty(null)).toBe(false);
});
it('recognizes an initially stopped fixed service only in its verified slice and inactive/failed state', async () => {
  observed.rootMissing = true; expect(await brokerCgroupEmpty(null)).toBe(true);
  observed.state = 'failed'; expect(await brokerCgroupEmpty(null)).toBe(true);
  observed.slice = 'foreign.slice'; expect(await brokerCgroupEmpty(null)).toBe(false);
  observed.slice = 'system.slice'; observed.state = 'activating'; expect(await brokerCgroupEmpty(null)).toBe(false);
});
it('accepts a removed original root but refuses missing child evidence or an unavailable cgroup filesystem', async () => {
  observed.group = original.cgroup;
  observed.rootMissing = true; expect(await brokerCgroupEmpty(original)).toBe(true);
  observed.rootMissing = false; observed.childMissing = true; expect(await brokerCgroupEmpty(original)).toBe(false);
  observed.childMissing = false; observed.controllersMissing = true; await expect(brokerCgroupEmpty(original)).rejects.toThrow();
});
