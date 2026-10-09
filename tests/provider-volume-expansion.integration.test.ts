import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandMountedProviderVolume, type VolumeCommand } from '../src/security/provider-volume-expansion.js';

it('native LUKS2 expansion preserves original keys contents and identity through interruption retry and replay', () => {
  if (process.getuid?.() !== 0 || process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1') {
    throw new Error('Explicit owning root native LUKS2 environment required; expansion coverage cannot be skipped.');
  }
  const root = mkdtempSync(join(tmpdir(), 'treeseed-native-volume-expansion-'));
  const backing = join(root, 'provider-data.luks'), mount = join(root, 'mounted');
  const mapper = `treeseed-test-${randomUUID()}`, device = `/dev/mapper/${mapper}`;
  const primary = randomBytes(32), recovery = randomBytes(32);
  const keyFile = join(root, 'primary.key'), recoveryFile = join(root, 'recovery.key');
  const run: VolumeCommand = (command, args, input) => execFileSync(command, [...args], {
    input, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  });
  let opened = false, mounted = false, loop = '';
  try {
    writeFileSync(backing, '', { mode: 0o600 }); truncateSync(backing, 1_073_741_824);
    writeFileSync(keyFile, primary, { mode: 0o600 }); writeFileSync(recoveryFile, recovery, { mode: 0o600 });
    mkdirSync(mount, { mode: 0o700 });
    run('/usr/sbin/cryptsetup', ['luksFormat', '--batch-mode', '--type', 'luks2', '--pbkdf', 'pbkdf2',
      '--pbkdf-force-iterations', '1000', '--key-file', keyFile, backing]);
    run('/usr/sbin/cryptsetup', ['luksAddKey', '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '1000',
      '--key-file', keyFile, '--new-keyfile', recoveryFile, backing]);
    run('/usr/sbin/cryptsetup', ['open', '--type', 'luks2', '--key-file', keyFile, backing, mapper]); opened = true;
    loop = /^\s*device:\s*(\/dev\/loop[0-9]+)\s*$/mu.exec(run('/usr/sbin/cryptsetup', ['status', mapper]))?.[1] ?? '';
    expect(loop).toMatch(/^\/dev\/loop[0-9]+$/u);
    run('/usr/sbin/mkfs.ext4', ['-q', device]);
    run('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', device, mount]); mounted = true;
    const sentinel = join(mount, 'retained-work.bin'), content = randomBytes(65_537);
    writeFileSync(sentinel, content, { mode: 0o600 });
    expect(expandMountedProviderVolume(backing, mount, 1_073_741_824, mapper, primary, run).expanded).toBe(false);
    // The original component installer owns Agent state as this unprivileged identity.
    chownSync(mount, 65_532, 65_532); chmodSync(mount, 0o700);
    const before = { metadata: run('/usr/sbin/cryptsetup', ['luksDump', '--dump-json-metadata', backing]),
      uuid: run('/usr/sbin/blkid', ['-s', 'UUID', '-o', 'value', device]), inode: lstatSync(backing).ino,
      available: statfsSync(mount).bavail * statfsSync(mount).bsize };
    for (const [uid, gid, mode] of [[65_533, 65_533, 0o700], [65_532, 65_533, 0o700], [65_532, 65_532, 0o720], [65_532, 65_532, 0o702]] as const) {
      chownSync(mount, uid, gid); chmodSync(mount, mode);
      expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run)).toThrow(/custody/);
      expect(lstatSync(backing).size).toBe(1_073_741_824); expect(readFileSync(sentinel)).toEqual(content);
      expect(lstatSync(mount).uid).toBe(uid); expect(lstatSync(mount).gid).toBe(gid);
      expect(lstatSync(mount).mode & 0o777).toBe(mode);
    }
    chownSync(mount, 65_532, 65_532); chmodSync(mount, 0o700);
    const substituted = join(root, 'substituted.luks'); symlinkSync(backing, substituted);
    expect(() => expandMountedProviderVolume(substituted, mount, 2_147_483_648, mapper, primary, run)).toThrow();
    const wrongKey = randomBytes(32);
    try { expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, wrongKey, run)).toThrow(); }
    finally { wrongKey.fill(0); }
    expect(lstatSync(backing).size).toBe(1_073_741_824);
    expect(readFileSync(sentinel)).toEqual(content);
    const calls: string[][] = [];
    const interrupted: VolumeCommand = (command, args, input) => {
      calls.push([command, ...args]);
      if (command === '/usr/sbin/cryptsetup' && args[0] === 'resize') throw new Error('controlled interruption before mapping growth');
      return run(command, args, input);
    };
    expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, interrupted)).toThrow(/controlled interruption/);
    expect(lstatSync(backing).size).toBe(2_147_483_648);
    expect(readFileSync(sentinel)).toEqual(content);
    expect(run('/usr/sbin/cryptsetup', ['luksDump', '--dump-json-metadata', backing])).toBe(before.metadata);
    for (const bytes of [1_073_741_824, NaN, 2_147_483_649]) {
      expect(() => expandMountedProviderVolume(backing, mount, bytes, mapper, primary, run)).toThrow();
      expect(lstatSync(backing).size).toBe(2_147_483_648);
    }
    expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, `${mapper}-foreign`, primary, run)).toThrow();
    const result = expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run);
    expect(result.expanded).toBe(true);
    expect(statfsSync(mount).bavail * statfsSync(mount).bsize).toBeGreaterThan(before.available);
    expect(readFileSync(sentinel)).toEqual(content); expect(lstatSync(backing).ino).toBe(before.inode);
    expect(run('/usr/sbin/blkid', ['-s', 'UUID', '-o', 'value', device])).toBe(before.uuid);
    expect(run('/usr/sbin/cryptsetup', ['luksDump', '--dump-json-metadata', backing])).toBe(before.metadata);
    expect(expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run).expanded).toBe(false);
    expect(lstatSync(mount).uid).toBe(65_532); expect(lstatSync(mount).gid).toBe(65_532);
    expect(lstatSync(mount).mode & 0o777).toBe(0o700);
    expect(readFileSync(keyFile)).toEqual(primary); expect(readFileSync(recoveryFile)).toEqual(recovery);
    run('/usr/bin/umount', [mount]); mounted = false;
    run('/usr/sbin/cryptsetup', ['close', mapper]); opened = false;
    run('/usr/sbin/cryptsetup', ['open', '--type', 'luks2', '--key-file', recoveryFile, backing, mapper]); opened = true;
    run('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', device, mount]); mounted = true;
    expect(readFileSync(sentinel)).toEqual(content);
    expect(lstatSync(mount).uid).toBe(65_532); expect(lstatSync(mount).gid).toBe(65_532);
    expect(lstatSync(mount).mode & 0o777).toBe(0o700);
  } finally {
    primary.fill(0); recovery.fill(0);
    if (mounted) run('/usr/bin/umount', [mount]);
    if (opened) run('/usr/sbin/cryptsetup', ['close', mapper]);
    if (loop && run('/usr/sbin/losetup', ['--associated', backing]).trim()) throw new Error('Allocated fixture loop remains attached; retaining fixture.');
    expect(existsSync(device)).toBe(false);
    rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false);
  }
}, 30_000);
