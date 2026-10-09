import { expect, it, vi } from 'vitest';
import { assertProviderVolumeBackingCustody, assertProviderVolumeGeometry, assertProviderVolumeMountCustody, planProviderVolumeExpansion, providerVolumeMappingGeometry, providerVolumeMountedAuthority } from '../src/security/provider-volume-expansion.js';
import { createProviderVolumeBacking, providerSecurityStatus } from '../src/security/provider-volume.js';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { supervisorConnectionHandler } from '../src/supervisor/server.js';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { host } from './fixtures.js';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

const boundary = vi.hoisted(() => ({ load: vi.fn(), grow: vi.fn(), persist: vi.fn(), backup: vi.fn() }));
vi.mock('../src/core/configuration.js', async original => ({ ...await original<typeof import('../src/core/configuration.js')>(), loadHostConfiguration: boundary.load }));
vi.mock('../src/core/files.js', async original => ({ ...await original<typeof import('../src/core/files.js')>(), atomicJson: boundary.persist }));
vi.mock('../src/supervisor/backup-configuration.js', async original => ({ ...await original<typeof import('../src/supervisor/backup-configuration.js')>(), preserveAcceptedConfiguration: boundary.backup }));
vi.mock('../src/security/provider-volume-expansion.js', async original => ({ ...await original<typeof import('../src/security/provider-volume-expansion.js')>(), expandConfiguredProviderVolume: boundary.grow }));

const volume: NonNullable<HostConfiguration['security']>['providerVolume'] = {
  encryption: 'luks2', backingPath: '/var/lib/treeseed/encrypted/provider-data.luks',
  mountPath: '/var/lib/treeseed/agent', sizeBytes: 17_179_869_184,
  unlock: 'systemd-credential', recoveryRequired: true,
};

it('accepts identical supervisor bind mount views but denies any missing malformed or contradictory mounted authority', () => {
  const device = '/dev/mapper/treeseed-provider-data', mount = '/var/lib/treeseed/agent';
  const view = { source: device, target: mount, fstype: 'ext4', options: 'rw,nosuid,nodev,noexec,relatime', uuid: 'ec8bb67d-0a23-4f20-ad9a-67bf6a36544d' };
  const input = { filesystems: [view, { ...view }] }, before = structuredClone(input);
  expect(providerVolumeMountedAuthority(input, device, mount)).toEqual(view);
  expect(providerVolumeMountedAuthority({ filesystems: [view] }, device, mount)).toEqual(view);
  for (const invalid of [undefined, null, {}, [], { filesystems: [] }, { filesystems: null },
    { filesystems: [null] }, { filesystems: [view, null] }, { filesystems: [view, {}] }]) {
    expect(() => providerVolumeMountedAuthority(invalid, device, mount)).toThrow();
  }
  for (const change of [{ source: '/dev/mapper/foreign' }, { target: '/foreign' }, { fstype: 'xfs' },
    { uuid: '' }, { uuid: 'fc8bb67d-0a23-4f20-ad9a-67bf6a36544d' }, { options: 'ro,nosuid,nodev,noexec' },
    { options: 'rw,nodev,noexec' }, { options: 'rw,nosuid,noexec' }, { options: 'rw,nosuid,nodev' }]) {
    expect(() => providerVolumeMountedAuthority({ filesystems: [view, { ...view, ...change }] }, device, mount)).toThrow();
  }
  for (const field of Object.keys(view)) for (const value of [undefined, null, '', 0, false, []]) {
    expect(() => providerVolumeMountedAuthority({ filesystems: [view, { ...view, [field]: value }] }, device, mount)).toThrow();
  }
  expect(input).toEqual(before);
});

it('creates private exclusive provider backing under the operator umask without replacing existing bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-volume-create-')), backing = join(root, 'provider-data.luks');
  const mask = process.umask(0o007);
  try {
    createProviderVolumeBacking(backing, 1_073_741_824);
    const original = lstatSync(backing);
    expect(original.mode & 0o7777).toBe(0o600); expect(original.size).toBe(1_073_741_824);
    expect(original.nlink).toBe(1);
    expect(() => createProviderVolumeBacking(backing, 2_147_483_648)).toThrow();
    expect(lstatSync(backing).ino).toBe(original.ino); expect(lstatSync(backing).size).toBe(original.size);
    const retained = join(root, 'retained'); writeFileSync(retained, 'retained encrypted input', { mode: 0o600 });
    const alias = join(root, 'alias'); symlinkSync(retained, alias);
    expect(() => createProviderVolumeBacking(alias, 1_073_741_824)).toThrow();
    for (const size of [0, -1, 1.5, NaN, Infinity, 1_073_741_825]) {
      expect(() => createProviderVolumeBacking(join(root, 'invalid'), size)).toThrow();
    }
    expect(readFileSync(retained, 'utf8')).toBe('retained encrypted input');
  } finally { process.umask(mask); rmSync(root, { recursive: true }); }
});

it('admits only exact private or installed group-mode backing custody for authenticated tightening', () => {
  const original = { uid: 0, mode: 0o100600, nlink: 1, isFile: () => true };
  expect(() => assertProviderVolumeBackingCustody(original)).not.toThrow();
  expect(() => assertProviderVolumeBackingCustody({ ...original, mode: 0o100660 })).not.toThrow();
  for (const change of [{ uid: 1000 }, { nlink: 2 }, { isFile: () => false },
    ...[0o100640, 0o100666, 0o100700, 0o104600, 0o100000].map(mode => ({ mode }))]) {
    expect(() => assertProviderVolumeBackingCustody({ ...original, ...change })).toThrow(/custody/);
  }
  for (const field of ['uid', 'mode', 'nlink']) for (const value of [undefined, null, '', '0', -1, 1.5, NaN, Infinity]) {
    expect(() => assertProviderVolumeBackingCustody(Object.assign({}, original, { [field]: value }))).toThrow(/custody/);
  }
  expect(original).toMatchObject({ uid: 0, mode: 0o100600, nlink: 1 });
});

it('returns only read-only configured provider path metadata through security status', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-volume-status-'));
  const directory = join(root, '.treeseed/data/.encrypted'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backing = join(directory, 'provider-data.luks'), mount = join(root, 'mounted');
  const config = host(); config.runtime.environment = 'development';
  config.security = { providerVolume: { ...volume, backingPath: backing, mountPath: mount },
    sandbox: { required: true, runtime: 'kata-runtime-rs-qemu', brokerSocket: '/run/treeseed/sandbox/broker.sock',
      modelGateway: { provider: 'openai', upstreamBaseUrl: 'https://api.openai.com', allowedModels: ['test-model'] },
      profiles: [{ id: 'test-profile', guestImage: 'treeseed/test', guestImageDigest: `sha256:${'a'.repeat(64)}` }] },
    applicationEncryption: { provider: 'systemd-credential', activeKeyVersion: 1, diagnosticsKeyVersion: 1 } };
  boundary.load.mockReturnValue(config);
  try {
    writeFileSync(backing, 'never disclose encrypted bytes', { mode: 0o660 }); mkdirSync(mount, { mode: 0o700 });
    const before = lstatSync(backing), bytes = readFileSync(backing);
    const status = providerSecurityStatus();
    expect(status).toMatchObject({ backing: { type: 'file', uid: before.uid, gid: before.gid,
      mode: before.mode & 0o7777, links: 1, sizeBytes: bytes.length },
    mount: { type: 'directory', uid: process.getuid?.(), mode: 0o700 } });
    expect(Object.keys(status.backing!).sort()).toEqual(['gid', 'links', 'mode', 'sizeBytes', 'type', 'uid']);
    expect(JSON.stringify(status)).not.toContain(bytes.toString());
    expect(readFileSync(backing)).toEqual(bytes); expect(lstatSync(backing).mode).toBe(before.mode);
    rmSync(backing); rmSync(mount, { recursive: true });
    expect(providerSecurityStatus()).toMatchObject({ backing: null, mount: null, backingExists: false, mounted: false });
    symlinkSync(join(root, 'absent'), backing); expect(() => providerSecurityStatus()).toThrow(/symbolic/);
  } finally { rmSync(root, { recursive: true }); }
});

it('native supervisor socket returns configured security metadata and rejects caller paths without running commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-status-socket-')), socket = join(root, 'supervisor.sock');
  const directory = join(root, '.treeseed/data/.encrypted'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backing = join(directory, 'provider-data.luks'); writeFileSync(backing, 'private ciphertext', { mode: 0o600 });
  const config = host(); config.runtime.environment = 'development';
  config.security = { providerVolume: { ...volume, backingPath: backing, mountPath: join(root, 'absent') },
    sandbox: { required: true, runtime: 'kata-runtime-rs-qemu', brokerSocket: '/run/treeseed/sandbox/broker.sock',
      modelGateway: { provider: 'openai', upstreamBaseUrl: 'https://api.openai.com', allowedModels: ['test-model'] },
      profiles: [{ id: 'renamed-profile', guestImage: 'treeseed/test', guestImageDigest: `sha256:${'a'.repeat(64)}` }] },
    applicationEncryption: { provider: 'systemd-credential', activeKeyVersion: 1, diagnosticsKeyVersion: 1 } };
  boundary.load.mockReturnValue(config);
  const command = vi.fn(() => { throw new Error('Read-only status must not execute a command'); });
  const events: string[] = [];
  const server = createServer({ allowHalfOpen: true }, supervisorConnectionHandler(
    input => executeSupervisorOperation(input, command), name => { events.push(name); }));
  server.listen(socket); await once(server, 'listening');
  const exchange = async (input: unknown) => {
    const client = createConnection(socket); let raw = ''; client.setEncoding('utf8');
    client.on('data', chunk => { raw += chunk; });
    try { await once(client, 'connect'); client.end(JSON.stringify(input)); await once(client, 'end'); return JSON.parse(raw); }
    finally { client.destroy(); }
  };
  try {
    const metadata = lstatSync(backing), expected = providerSecurityStatus();
    const response = await exchange({ operation: 'security.status' });
    expect(response).toEqual({ ok: true, result: expected });
    expect(response.result.backing).toEqual({ type: 'file', uid: metadata.uid, gid: metadata.gid,
      mode: 0o600, links: 1, sizeBytes: 18 });
    for (const extra of [{ path: '/etc/shadow' }, { command: '/bin/sh' }, { args: ['-c', 'id'] }]) {
      expect(await exchange({ operation: 'security.status', ...extra })).toEqual({ ok: false, error: 'operation_failed', operation: 'security.status' });
    }
    expect(await exchange({ operation: 'security.status' })).toEqual(response);
    expect(events).toEqual(['supervisor.operation-complete', ...Array<string>(3).fill('supervisor.operation-failed'), 'supervisor.operation-complete']);
    expect(command).not.toHaveBeenCalled(); expect(boundary.persist).not.toHaveBeenCalled();
    expect(readFileSync(backing, 'utf8')).toBe('private ciphertext'); expect(lstatSync(backing).mode).toBe(metadata.mode);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(root, { recursive: true }); }
});

it('preserves installed provider mount ownership while denying foreign writable or malformed custody', () => {
  const provider = { uid: 65_532, gid: 65_532, mode: 0o40700 }, before = structuredClone(provider);
  expect(() => assertProviderVolumeMountCustody(provider)).not.toThrow();
  expect(() => assertProviderVolumeMountCustody({ uid: 0, gid: 0, mode: 0o40700 })).not.toThrow();
  for (const changed of [{ uid: 65_533 }, { gid: 65_533 }, { uid: 1000, gid: 1000 },
    { mode: 0o40720 }, { mode: 0o40702 }, { mode: 0o40777 }]) {
    expect(() => assertProviderVolumeMountCustody({ ...provider, ...changed })).toThrow(/custody/);
  }
  for (const field of ['uid', 'gid', 'mode']) for (const value of [undefined, null, '', '65532', -1, 1.5, NaN, Infinity]) {
    expect(() => assertProviderVolumeMountCustody(Object.assign({}, provider, { [field]: value }))).toThrow(/custody/);
  }
  expect(provider).toEqual(before);
});

it('reads native cryptsetup mapping units exactly and denies contradictory or ambiguous geometry', () => {
  const status = '  type: LUKS2\n  device: /dev/loop17\n  offset: 32768 [512-byte units] (16777216 [bytes])\n  mode: read/write\n';
  expect(providerVolumeMappingGeometry(status)).toEqual({ loop: '/dev/loop17', offsetBytes: 16_777_216 });
  expect(providerVolumeMappingGeometry(status.replace('32768 [512-byte units] (16777216 [bytes])', '32768 sectors')))
    .toEqual({ loop: '/dev/loop17', offsetBytes: 16_777_216 });
  for (const changed of [status.replace('16777216 [bytes]', '16777215 [bytes]'),
    status.replace('32768 [512-byte units]', '32768 [4096-byte units]'), status.replace('32768 [512-byte units]', '0 [512-byte units]'),
    status.replace('32768 [512-byte units]', '-1 [512-byte units]'), status.replace('32768 [512-byte units]', '1.5 [512-byte units]'),
    status.replace('32768 [512-byte units]', '9007199254740992 [512-byte units]'),
    status.replace('LUKS2', 'PLAIN'), status.replace('read/write', 'readonly'), status.replace('/dev/loop17', '/dev/sda'),
    status.replace('  offset:', '  absent:'), `${status}  offset: 32768 sectors\n`, `${status}  device: /dev/loop18\n`]) {
    expect(() => providerVolumeMappingGeometry(changed)).toThrow();
  }
  expect(status).toBe('  type: LUKS2\n  device: /dev/loop17\n  offset: 32768 [512-byte units] (16777216 [bytes])\n  mode: read/write\n');
});

it('reports only allowlisted mapping type and mode facts when privileged status denies expansion', () => {
  const status = '  type: LUKS2\n  device: /dev/loop17\n  offset: 32768 sectors\n  mode: read/write\n';
  for (const type of ['LUKS1', 'PLAIN', 'n/a']) {
    expect(() => providerVolumeMappingGeometry(status.replace('LUKS2', type)))
      .toThrow(`Provider mapping is not writable LUKS2 (type=${type}, mode=read/write).`);
  }
  for (const mode of ['readonly', 'read-only', 'n/a']) {
    expect(() => providerVolumeMappingGeometry(status.replace('read/write', mode)))
      .toThrow(`Provider mapping is not writable LUKS2 (type=LUKS2, mode=${mode}).`);
  }
  const privateValue = 'never-disclose-private-command-output';
  expect(() => providerVolumeMappingGeometry(status.replace('LUKS2', privateValue).replace('read/write', privateValue)))
    .toThrow('Provider mapping is not writable LUKS2 (type=unknown, mode=unknown).');
});

it('accepts only monotonic same-authority provider volume expansion', () => {
  const next = { ...volume, sizeBytes: 34_359_738_368 }, before = structuredClone([volume, next]);
  expect(planProviderVolumeExpansion(volume, next)).toEqual(next);
  expect(planProviderVolumeExpansion(volume, { ...volume })).toBeUndefined();
  expect(planProviderVolumeExpansion(undefined, next)).toBeUndefined();
  for (const sizeBytes of [0, -1, 1.5, NaN, Infinity, 8_589_934_592, 34_359_738_369, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => planProviderVolumeExpansion(volume, { ...next, sizeBytes })).toThrow();
  }
  for (const change of [{ backingPath: '/tmp/foreign' }, { mountPath: '/tmp/foreign' }, { unlock: 'tpm2' as const }]) {
    expect(() => planProviderVolumeExpansion(volume, { ...next, ...change })).toThrow(/authority/);
  }
  expect(() => planProviderVolumeExpansion(volume, undefined)).toThrow(/authority/);
  expect([volume, next]).toEqual(before);
});

it('denies invalid mounted volume geometry before expansion writes', () => {
  const facts = { backingBytes: 17_179_869_184, loopBytes: 17_179_869_184,
    mappedBytes: 17_163_091_968, offsetBytes: 16_777_216,
    filesystemBytes: 17_163_091_968, blockSize: 4096 };
  const before = structuredClone(facts);
  expect(assertProviderVolumeGeometry(facts, 34_359_738_368)).toBe(34_342_961_152);
  // Interrupted growth may leave any earlier layer larger than the next one.
  expect(assertProviderVolumeGeometry({ ...facts, backingBytes: 34_359_738_368 }, 34_359_738_368)).toBe(34_342_961_152);
  for (const key of Object.keys(facts)) for (const value of [undefined, null, '', '4096', 0, -1, 1.5, NaN, Infinity]) {
    expect(() => assertProviderVolumeGeometry(Object.assign({}, facts, { [key]: value }), 34_359_738_368)).toThrow();
  }
  for (const change of [{ loopBytes: facts.backingBytes + 4096 }, { mappedBytes: facts.loopBytes },
    { filesystemBytes: facts.mappedBytes + 4096 }, { offsetBytes: facts.backingBytes }, { blockSize: 3 }]) {
    expect(() => assertProviderVolumeGeometry({ ...facts, ...change }, 34_359_738_368)).toThrow();
  }
  expect(() => assertProviderVolumeGeometry(facts, facts.backingBytes - 4096)).toThrow();
  expect(facts).toEqual(before);
});

it('persists configured capacity only after successful expansion and retains old configuration on failure', () => {
  const current = host();
  current.security = {
    providerVolume: volume,
    sandbox: { required: true, runtime: 'kata-runtime-rs-qemu', brokerSocket: '/run/treeseed/sandbox/broker.sock',
      modelGateway: { provider: 'openai', upstreamBaseUrl: 'https://api.openai.com', allowedModels: ['test-model'] },
      profiles: [{ id: 'test-profile', guestImage: 'treeseed/test', guestImageDigest: `sha256:${'a'.repeat(64)}` }] },
    applicationEncryption: { provider: 'systemd-credential', activeKeyVersion: 1, diagnosticsKeyVersion: 1 },
  };
  const candidate = structuredClone(current); candidate.generation++;
  candidate.security!.providerVolume.sizeBytes = 34_359_738_368;
  const before = structuredClone([current, candidate]);
  boundary.load.mockReturnValue(current);
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(1000);
  try {
    expect(() => executeSupervisorOperation({ operation: 'configuration.replace', configuration: candidate })).toThrow(/must run as root/);
    expect(boundary.persist).not.toHaveBeenCalled();
    uid.mockReturnValue(0); // Controlled UNIT caller, not native root authorization proof.
    for (const message of ['ownership denied', 'native resize interrupted', 'readback changed']) {
      boundary.persist.mockClear();
      boundary.grow.mockImplementation(() => { throw new Error(message); });
      expect(() => executeSupervisorOperation({ operation: 'configuration.replace', configuration: candidate })).toThrow(message);
      expect(boundary.persist).not.toHaveBeenCalled();
      expect([current, candidate]).toEqual(before);
    }
    boundary.grow.mockImplementation(() => { expect(boundary.persist).not.toHaveBeenCalled(); });
    executeSupervisorOperation({ operation: 'configuration.replace', configuration: candidate });
    expect(boundary.grow).toHaveBeenLastCalledWith(current, candidate);
    expect(boundary.persist).toHaveBeenCalledExactlyOnceWith('/etc/treeseed/platform.json', candidate, 0o640);
    expect([current, candidate]).toEqual(before);
  } finally { uid.mockRestore(); }
});
