import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, statfsSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { providerSecuritySettings } from './provider-volume.js';
import { providerVolumeMapperName } from './provider-volume-identity.js';
import { credentialRoot } from './credential-initializers.js';

type Volume = NonNullable<HostConfiguration['security']>['providerVolume'];
export type VolumeCommand = (command: string, args: readonly string[], input?: Buffer) => string;
const run: VolumeCommand = (command, args, input) => {
  try { return execFileSync(command, [...args], { input, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 1_048_576, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } }); }
  catch { throw new Error('Provider volume expansion command failed; retained geometry requires verified retry.'); }
};

export function planProviderVolumeExpansion(current: Volume | undefined, next: Volume | undefined) {
  if (!current) return undefined; // Initial installation still owns formatting.
  if (!next || Object.entries(current).some(([key, value]) => key !== 'sizeBytes' && next[key as keyof Volume] !== value)) {
    throw new Error('Provider volume expansion cannot change encryption authority.');
  }
  if (!Number.isSafeInteger(next.sizeBytes) || next.sizeBytes < current.sizeBytes || next.sizeBytes % 4096 !== 0) {
    throw new Error('Provider volume expansion requires a monotonic aligned size.');
  }
  return next.sizeBytes === current.sizeBytes ? undefined : next;
}

export function assertProviderVolumeGeometry(facts: { backingBytes: number; loopBytes: number;
  mappedBytes: number; offsetBytes: number; filesystemBytes: number; blockSize: number }, target: number) {
  if (Object.values(facts).some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    || !Number.isSafeInteger(target) || target < 1_073_741_824 || target % 4096 !== 0
    || facts.blockSize < 512 || facts.blockSize > 65_536 || (facts.blockSize & (facts.blockSize - 1)) !== 0
    || target < facts.backingBytes || facts.loopBytes > facts.backingBytes
    || facts.mappedBytes + facts.offsetBytes > facts.loopBytes || facts.filesystemBytes > facts.mappedBytes
    || facts.offsetBytes >= facts.backingBytes || facts.offsetBytes % 4096 !== 0
    || facts.filesystemBytes % facts.blockSize !== 0) throw new Error('Provider volume geometry is invalid or would shrink.');
  return Math.floor((target - facts.offsetBytes) / facts.blockSize) * facts.blockSize;
}

function privatePath(path: string, directory: boolean) {
  const info = lstatSync(path);
  assert((directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
    && info.uid === 0 && !(info.mode & 0o077) && realpathSync(path) === path,
  'Provider volume custody changed.');
  return info;
}

export function assertProviderVolumeBackingCustody(info: Pick<Stats, 'uid' | 'mode' | 'nlink' | 'isFile'>) {
  // Only the exact former installer mode is eligible for authenticated tightening.
  // It is not private custody until fchmod and independent readback below succeed.
  assert([info.uid, info.mode, info.nlink].every(value => Number.isSafeInteger(value) && value >= 0)
    && info.uid === 0 && info.nlink === 1 && info.isFile()
    && (info.mode === 0o100600 || info.mode === 0o100660), 'Provider volume custody changed.');
}

export function assertProviderVolumeMountCustody(info: Pick<Stats, 'uid' | 'gid' | 'mode'>) {
  // configureComponent owns Agent state as 65532:65532; mounted filesystem
  // ownership is not the root-only custody of the encrypted backing file.
  assert([info.uid, info.gid, info.mode].every(value => Number.isSafeInteger(value) && value >= 0)
    && info.mode <= 0o177777 && (info.uid === 0 || (info.uid === 65_532 && info.gid === 65_532))
    && !(info.mode & 0o022), 'Provider mount custody changed.');
}

export function providerVolumeMappingGeometry(status: string) {
  const field = (name: string) => {
    const lines = status.split('\n').map(line => line.trim()).filter(line => line.startsWith(`${name}:`));
    assert(lines.length === 1 && typeof lines[0] === 'string', 'Provider mapping geometry is missing or ambiguous.');
    return lines[0].slice(name.length + 1).trim();
  };
  assert(field('type') === 'LUKS2' && field('mode') === 'read/write', 'Provider mapping is not writable LUKS2.');
  const loop = field('device');
  assert.match(loop, /^\/dev\/loop[0-9]+$/u);
  // Native cryptsetup versions expose the same 512-byte units using either label.
  const offset = /^([0-9]+)[ \t]+(?:sectors|\[512-byte units\][ \t]+\(([0-9]+)[ \t]+\[bytes\]\))$/u.exec(field('offset'));
  assert(offset, 'Provider loop geometry is missing.');
  const offsetBytes = Number(offset[1]) * 512;
  assert(Number.isSafeInteger(offsetBytes) && offsetBytes > 0
    && (offset[2] === undefined || Number(offset[2]) === offsetBytes), 'Provider mapping offset units disagree.');
  return { loop, offsetBytes };
}

/** Grow only the already-mounted owning loop/LUKS2/ext4 stack. Never formats,
 * changes keys, shrinks, detaches, or rolls back a partially enlarged layer. */
export function expandMountedProviderVolume(backing: string, mount: string, target: number,
  mapper: string, credential: Buffer | undefined, command: VolumeCommand = run) {
  assert.equal(process.getuid?.(), 0, 'Provider volume expansion requires the owning root supervisor.');
  assert.match(mapper, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
  privatePath(dirname(backing), true);
  const mountInfo = lstatSync(mount);
  assertProviderVolumeMountCustody(mountInfo);
  assert(mountInfo.isDirectory()
    && realpathSync(mount) === mount, 'Provider mount custody changed.');
  const original = lstatSync(backing), device = `/dev/mapper/${mapper}`;
  assertProviderVolumeBackingCustody(original);
  assert(realpathSync(backing) === backing, 'Provider volume custody changed.');
  const descriptor = openSync(backing, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    assertProviderVolumeBackingCustody(opened);
    assert(opened.ino === original.ino && opened.dev === original.dev, 'Provider backing inode moved.');
    const raw: unknown = JSON.parse(command('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS,UUID']));
    assert(raw && typeof raw === 'object' && 'filesystems' in raw && Array.isArray(raw.filesystems) && raw.filesystems.length === 1);
    const mounted: unknown = raw.filesystems[0];
    assert(mounted && typeof mounted === 'object' && 'source' in mounted && mounted.source === device
      && 'target' in mounted && mounted.target === mount && 'fstype' in mounted && mounted.fstype === 'ext4'
      && 'options' in mounted && typeof mounted.options === 'string'
      && 'uuid' in mounted && typeof mounted.uuid === 'string' && /^[a-f0-9-]{36}$/u.test(mounted.uuid), 'Provider mounted authority changed.');
    const mountOptions = mounted.options.split(',');
    assert(['rw', 'nodev', 'nosuid', 'noexec'].every(option => mountOptions.includes(option)), 'Provider mount protections changed.');
    const { loop, offsetBytes } = providerVolumeMappingGeometry(command('/usr/sbin/cryptsetup', ['status', mapper]));
    const associated: unknown = JSON.parse(command('/usr/sbin/losetup', ['--json', '--list', '--associated', backing, '--output', 'NAME,BACK-FILE,BACK-INO,OFFSET,SIZELIMIT,RO']));
    assert(associated && typeof associated === 'object' && 'loopdevices' in associated
      && Array.isArray(associated.loopdevices) && associated.loopdevices.length === 1);
    const owner: unknown = associated.loopdevices[0];
    assert(owner && typeof owner === 'object' && 'name' in owner && owner.name === loop
      && 'back-file' in owner && owner['back-file'] === backing && 'back-ino' in owner && Number(owner['back-ino']) === original.ino
      && 'offset' in owner && owner.offset === 0 && 'sizelimit' in owner && owner.sizelimit === 0
      && 'ro' in owner && (owner.ro === false || owner.ro === 0), 'Provider loop ownership changed.');
    const header = () => command('/usr/sbin/cryptsetup', ['luksDump', '--dump-json-metadata', backing]);
    const beforeHeader = header();
    const filesystem = () => {
      const text = command('/usr/sbin/tune2fs', ['-l', device]);
      const blockSize = Number(/^Block size:\s*([0-9]+)\s*$/mu.exec(text)?.[1]);
      const blocks = Number(/^Block count:\s*([0-9]+)\s*$/mu.exec(text)?.[1]);
      const uuid = /^Filesystem UUID:\s*([a-f0-9-]{36})\s*$/mu.exec(text)?.[1];
      assert(uuid === mounted.uuid, 'Provider filesystem UUID changed.');
      return { blockSize, filesystemBytes: blockSize * blocks };
    };
    const bytes = (path: string) => Number(command('/usr/sbin/blockdev', ['--getsize64', path]).trim());
    const fs = filesystem(), loopBytes = bytes(loop), mappedBytes = bytes(device);
    const desired = assertProviderVolumeGeometry({ backingBytes: opened.size, loopBytes, mappedBytes,
      offsetBytes, ...fs }, target);
    const expanded = opened.size !== target || loopBytes !== target || mappedBytes !== desired || fs.filesystemBytes !== desired;
    const tighten = (opened.mode & 0o7777) === 0o660;
    if (!expanded && !tighten) return { expanded: false, sizeBytes: target, filesystemBytes: desired, uuid: mounted.uuid };
    if (expanded) {
      const available = statfsSync(dirname(backing));
      assert(available.bavail * available.bsize >= target - opened.size + 268_435_456, 'Provider backing storage admission is full.');
    }
    const keyArgs = credential ? ['--key-file', '-'] : ['--token-only'];
    // Authenticate before the first mutation; never place a key in argv or a plaintext file.
    command('/usr/sbin/cryptsetup', ['open', '--test-passphrase', '--type', 'luks2', ...keyArgs, backing], credential);
    const retained = lstatSync(backing);
    assertProviderVolumeBackingCustody(retained);
    assert(retained.ino === original.ino && retained.dev === original.dev && realpathSync(backing) === backing, 'Provider backing moved before growth.');
    privatePath(dirname(backing), true);
    if (tighten) { fchmodSync(descriptor, 0o600); fsyncSync(descriptor); }
    const secured = privatePath(backing, false);
    assert(secured.ino === original.ino && secured.dev === original.dev
      && (fstatSync(descriptor).mode & 0o7777) === 0o600, 'Provider backing private custody readback failed.');
    if (!expanded) return { expanded: false, sizeBytes: target, filesystemBytes: desired, uuid: mounted.uuid };
    if (opened.size !== target) { ftruncateSync(descriptor, target); fsyncSync(descriptor); }
    if (loopBytes !== target) command('/usr/sbin/losetup', ['--set-capacity', loop]);
    if (mappedBytes !== desired) command('/usr/sbin/cryptsetup', ['resize', ...keyArgs, mapper], credential);
    if (fs.filesystemBytes !== desired) command('/usr/sbin/resize2fs', [device]);
    assert(fstatSync(descriptor).size === target && bytes(loop) === target && bytes(device) === desired
      && filesystem().filesystemBytes === desired && header() === beforeHeader, 'Provider volume expansion readback changed identity or geometry.');
    assert(lstatSync(backing).ino === original.ino, 'Provider backing inode changed after growth.');
    return { expanded: true, sizeBytes: target, filesystemBytes: desired, uuid: mounted.uuid };
  } finally { closeSync(descriptor); }
}

/** Existing host configuration is the sole size authority. Persist it only after
 * successful growth; a failed layer remains intact for the same checked retry. */
export function expandConfiguredProviderVolume(current: HostConfiguration, candidate: HostConfiguration) {
  const volume = planProviderVolumeExpansion(current.security?.providerVolume, candidate.security?.providerVolume);
  if (!volume || !existsSync(volume.backingPath)) return;
  providerSecuritySettings(current); providerSecuritySettings(candidate);
  const credential = volume.unlock === 'systemd-credential'
    ? execFileSync('/usr/bin/systemd-creds', ['decrypt', '--name=treeseed-provider-volume-key', `${credentialRoot}/treeseed-provider-volume-key.cred`, '-']) : undefined;
  try { return expandMountedProviderVolume(volume.backingPath, volume.mountPath, volume.sizeBytes, providerVolumeMapperName, credential); }
  finally { credential?.fill(0); }
}
