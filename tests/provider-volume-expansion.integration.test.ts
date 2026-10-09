import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandMountedProviderVolume, providerVolumeMappingGeometry, type VolumeCommand } from '../src/security/provider-volume-expansion.js';
import { createProviderVolumeBacking } from '../src/security/provider-volume.js';

it('native LUKS2 expansion preserves original keys contents and identity through interruption retry and replay', () => {
  if (process.getuid?.() !== 0 || process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1') {
    throw new Error('Explicit owning root native LUKS2 environment required; expansion coverage cannot be skipped.');
  }
  const supervisor = readFileSync(new URL('../systemd/treeseed-manager-supervisor.service', import.meta.url), 'utf8');
  const writable = /^ReadWritePaths=(.+)$/mu.exec(supervisor)?.[1];
  if (!writable) throw new Error('Original supervisor writable-path contract missing.');
  const root = mkdtempSync('/var/lib/treeseed/treeseed-native-volume-expansion-');
  const backing = join(root, 'provider-data.luks'), mount = join(root, 'mounted');
  const mapper = `treeseed-test-${randomUUID()}`, device = `/dev/mapper/${mapper}`;
  const primary = randomBytes(32), recovery = randomBytes(32);
  const keyFile = join(root, 'primary.key'), recoveryFile = join(root, 'recovery.key');
  const nativeRun: VolumeCommand = (command, args, input) => execFileSync(command, [...args], {
    input, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  });
  const protectedCommand: VolumeCommand = (command, args, input) => nativeRun('/usr/bin/systemd-run', [
    '--quiet', '--wait', '--pipe', '--collect', `--unit=${mapper}-${randomUUID()}`,
    '--property=ProtectSystem=strict', '--property=PrivateTmp=yes', '--property=NoNewPrivileges=yes',
    `--property=ReadWritePaths=${writable}`, command, ...args,
  ], input);
  // Keep fixture loop creation in its owning namespace. Exercise expansion's
  // actual cryptsetup reads/authentication/resize in the hardened namespace;
  // creating a loop elsewhere would give the owning reader a different path view.
  const run: VolumeCommand = (command, args, input) => command === '/usr/sbin/cryptsetup'
    && (['status', 'luksDump', 'resize'].includes(args[0] ?? '') || args.includes('--test-passphrase'))
    ? protectedCommand(command, args, input) : nativeRun(command, args, input);
  let opened = false, mounted = false, bindMounted = false, loop = '';
  try {
    const mask = process.umask(0o007);
    try { createProviderVolumeBacking(backing, 1_073_741_824); }
    finally { process.umask(mask); }
    expect(lstatSync(backing).mode & 0o7777).toBe(0o600);
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
    // Real duplicate namespace view, as installed systemd ReadWritePaths creates.
    run('/usr/bin/mount', ['--bind', mount, mount]); bindMounted = true;
    const views: unknown = JSON.parse(run('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS,UUID']));
    expect(views).toHaveProperty('filesystems');
    if (!views || typeof views !== 'object' || !('filesystems' in views) || !Array.isArray(views.filesystems)) throw new Error('Native duplicate mount views missing.');
    expect(views.filesystems).toHaveLength(2); expect(views.filesystems[0]).toEqual(views.filesystems[1]);
    const sentinel = join(mount, 'retained-work.bin'), content = randomBytes(65_537);
    writeFileSync(sentinel, content, { mode: 0o600 });
    const locks = lstatSync('/run/cryptsetup');
    expect(locks.isDirectory()).toBe(true); expect(locks.uid).toBe(0); expect(locks.mode & 0o7777).toBe(0o700);
    // Reproduce the installed failure without weakening the actual LUKS2 gate.
    const denied = nativeRun('/usr/bin/systemd-run', ['--quiet', '--wait', '--pipe', '--collect',
      `--unit=${mapper}-denied`, '--property=ProtectSystem=strict', '--property=PrivateTmp=yes',
      '--property=NoNewPrivileges=yes', `--property=ReadWritePaths=${writable.split(/\s+/u).filter(path => path !== '/run/cryptsetup').join(' ')}`,
      '/usr/sbin/cryptsetup', 'status', mapper]);
    expect(() => providerVolumeMappingGeometry(denied)).toThrow('Provider mapping is not writable LUKS2 (type=n/a, mode=read/write).');
    expect(providerVolumeMappingGeometry(run('/usr/sbin/cryptsetup', ['status', mapper])))
      .toEqual({ loop, offsetBytes: 16_777_216 });
    const association: unknown = JSON.parse(nativeRun('/usr/sbin/losetup', ['--json', '--list', '--associated', backing,
      '--output', 'NAME,BACK-FILE,BACK-INO,OFFSET,SIZELIMIT,RO']));
    expect(association).toMatchObject({ loopdevices: [{ name: loop, 'back-file': backing, offset: 0, sizelimit: 0 }] });
    if (!association || typeof association !== 'object' || !('loopdevices' in association)
      || !Array.isArray(association.loopdevices) || association.loopdevices.length !== 1) throw new Error('Native owning loop inventory differs.');
    const owned: unknown = association.loopdevices[0];
    if (!owned || typeof owned !== 'object' || !('back-ino' in owned) || !('ro' in owned)) throw new Error('Native loop custody missing.');
    expect(Number(owned['back-ino'])).toBe(lstatSync(backing).ino); expect([false, 0]).toContain(owned.ro);
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
    for (const mode of [0o666, 0o640, 0o700, 0o4600]) {
      chmodSync(backing, mode);
      expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run)).toThrow(/custody/);
      expect(lstatSync(backing).mode & 0o7777).toBe(mode);
    }
    chmodSync(backing, 0o660); chownSync(backing, 0, 118);
    const alias = join(root, 'hardlink'); linkSync(backing, alias);
    expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run)).toThrow(/custody/);
    expect(lstatSync(backing).mode & 0o7777).toBe(0o660); rmSync(alias);
    chownSync(backing, 1000, 118);
    expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run)).toThrow(/custody/);
    expect(lstatSync(backing).uid).toBe(1000); chownSync(backing, 0, 118);
    const wrongKey = randomBytes(32);
    try { expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, wrongKey, run)).toThrow(); }
    finally { wrongKey.fill(0); }
    expect(lstatSync(backing).mode & 0o7777).toBe(0o660);
    expect(() => expandMountedProviderVolume(backing, mount, 2_147_483_648, `${mapper}-foreign`, primary, run)).toThrow();
    expect(lstatSync(backing).mode & 0o7777).toBe(0o660);
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
    expect(lstatSync(backing).mode & 0o7777).toBe(0o600);
    expect(lstatSync(backing).uid).toBe(0); expect(lstatSync(backing).gid).toBe(118);
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
    // Same-size authenticated reconciliation must also repair only the old mode.
    chmodSync(backing, 0o660);
    expect(expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run).expanded).toBe(false);
    expect(lstatSync(backing).mode & 0o7777).toBe(0o600);
    expect(lstatSync(backing).ino).toBe(before.inode);
    expect(run('/usr/sbin/cryptsetup', ['luksDump', '--dump-json-metadata', backing])).toBe(before.metadata);
    expect(lstatSync(mount).uid).toBe(65_532); expect(lstatSync(mount).gid).toBe(65_532);
    expect(lstatSync(mount).mode & 0o777).toBe(0o700);
    expect(readFileSync(keyFile)).toEqual(primary); expect(readFileSync(recoveryFile)).toEqual(recovery);
    run('/usr/bin/umount', [mount]); bindMounted = false;
    run('/usr/bin/umount', [mount]); mounted = false;
    run('/usr/sbin/cryptsetup', ['close', mapper]); opened = false;
    // Preserve the original counterexample too: a later supervisor may own a
    // different mount namespace from the process that created the loop mapping.
    protectedCommand('/usr/sbin/cryptsetup', ['open', '--type', 'luks2', '--key-file', recoveryFile, backing, mapper]); opened = true;
    run('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', device, mount]); mounted = true;
    expect(readFileSync(sentinel)).toEqual(content);
    expect(lstatSync(mount).uid).toBe(65_532); expect(lstatSync(mount).gid).toBe(65_532);
    expect(lstatSync(mount).mode & 0o777).toBe(0o700);
    try { expect(expandMountedProviderVolume(backing, mount, 2_147_483_648, mapper, primary, run).expanded).toBe(false); }
    catch (cause) {
      const actual = nativeRun('/usr/sbin/losetup', ['--json', '--list', '--associated', backing,
        '--output', 'NAME,BACK-FILE,BACK-INO,OFFSET,SIZELIMIT,RO']);
      throw new Error(`Native cross-namespace ownership failed; original inode=${lstatSync(backing).ino}; actual association=${actual}`, { cause });
    }
  } finally {
    primary.fill(0); recovery.fill(0);
    if (bindMounted) run('/usr/bin/umount', [mount]);
    if (mounted) run('/usr/bin/umount', [mount]);
    if (opened) run('/usr/sbin/cryptsetup', ['close', mapper]);
    if (loop && run('/usr/sbin/losetup', ['--associated', backing]).trim()) throw new Error('Allocated fixture loop remains attached; retaining fixture.');
    expect(existsSync(device)).toBe(false);
    expect(nativeRun('/usr/bin/systemctl', ['list-units', '--all', '--no-legend', '--plain', '--no-pager', `${mapper}-*.service`]).trim()).toBe('');
    rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false);
  }
}, 30_000);
