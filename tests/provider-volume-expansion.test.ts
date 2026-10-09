import { expect, it, vi } from 'vitest';
import { assertProviderVolumeGeometry, planProviderVolumeExpansion, providerVolumeMappingGeometry } from '../src/security/provider-volume-expansion.js';
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
