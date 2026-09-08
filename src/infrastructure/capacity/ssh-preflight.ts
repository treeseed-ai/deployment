import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Destination approval must come from deployment network policy, not service form data. */
export interface SshHostAuthority {
  address: string;
  port: number;
  username: string;
  hostPublicKey: string;
  elevation: 'root' | 'sudo';
}
export interface SshPreflightResult {
  schemaVersion: 'treeseed.ssh-host-preflight/v1';
  os: 'ubuntu';
  version: '26.04';
  architecture: 'x86_64';
  kvmApiVersion: 12;
  kvmVmCreated: true;
  hostKeyFingerprint: string;
  admission: 'kata-acceptance-required';
}
export type SshCommand = (args: string[], input: string) => { status: number | null; stdout: string };
const command: SshCommand = (args, input) => {
  const result = spawnSync('/usr/bin/ssh', args, { input, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  // Do not expose stderr: a remote login banner or command error can contain arbitrary data.
  return { status: result.status, stdout: result.stdout ?? '' };
};

export const SSH_KVM_PREFLIGHT = `import os, json, platform, fcntl
try:
 if os.geteuid() != 0: raise RuntimeError()
 release = platform.freedesktop_os_release()
 if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '26.04': raise RuntimeError()
 if platform.machine() != 'x86_64': raise RuntimeError()
 if not os.path.isfile('/usr/bin/dpkg'): raise RuntimeError()
 fd = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
 try:
  if fcntl.ioctl(fd, 0xAE00, 0) != 12: raise RuntimeError()
  vm = fcntl.ioctl(fd, 0xAE01, 0)
  os.close(vm)
 finally: os.close(fd)
 print(json.dumps({'os':'ubuntu','version':'26.04','architecture':'x86_64','kvmApiVersion':12,'kvmVmCreated':True}))
except Exception:
 print('TreeSeed SSH host preflight failed')
 raise SystemExit(1)
`;

export function sshHostArguments(host: SshHostAuthority, directory: string) {
  if (!isIP(host.address) || /[%\s]/u.test(host.address) || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535
    || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(host.username) || !['root', 'sudo'].includes(host.elevation)
    || (host.elevation === 'root' && host.username !== 'root')) throw new Error('Invalid SSH host descriptor.');
  // Pin the full public key, not a trust-on-first-use scan of the same untrusted endpoint.
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/u.test(host.hostPublicKey)) throw new Error('A trusted Ed25519 SSH host public key is required.');
  const wire = Buffer.from(host.hostPublicKey.split(' ')[1]!, 'base64');
  if (wire.length !== 51 || wire.readUInt32BE(0) !== 11 || wire.subarray(4, 15).toString() !== 'ssh-ed25519'
    || wire.readUInt32BE(15) !== 32) throw new Error('Invalid SSH host public key.');
  return { fingerprint: 'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/u, ''),
    knownHost: `[${host.address}]:${host.port} ${host.hostPublicKey}\n${host.address} ${host.hostPublicKey}\n`,
    args: ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${join(directory, 'known_hosts')}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=10',
      '-i', join(directory, 'identity'), '-p', String(host.port), '-l', host.username, '--', host.address,
      host.elevation === 'sudo' ? 'sudo -n python3 -' : 'python3 -'] };
}

/** Read-only machine qualification. No installation, enrollment, or Kata admission is implied. */
export async function preflightSshCapacityHost(input: { host: SshHostAuthority; privateKey: Buffer;
  authorizeDestination: (address: string, port: number) => Promise<boolean>; runtimeDirectory: string;
  run?: SshCommand }): Promise<SshPreflightResult> {
  // Validate all inputs before touching credentials or contacting the host.
  sshHostArguments(input.host, input.runtimeDirectory);
  if (!await input.authorizeDestination(input.host.address, input.host.port)) throw new Error('SSH destination is not deployment-authorized.');
  const directory = mkdtempSync(join(input.runtimeDirectory, 'ssh-preflight-'));
  try {
    const selected = sshHostArguments(input.host, directory);
    writeFileSync(join(directory, 'identity'), input.privateKey, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(directory, 'known_hosts'), selected.knownHost, { mode: 0o600, flag: 'wx' });
    const result = (input.run ?? command)(selected.args, SSH_KVM_PREFLIGHT);
    if (result.status !== 0) throw new Error('SSH authentication, host trust, or KVM preflight failed.');
    let record: Record<string, unknown>;
    try { record = JSON.parse(result.stdout); } catch { throw new Error('Invalid SSH preflight response.'); }
    if (record.os !== 'ubuntu' || record.version !== '26.04' || record.architecture !== 'x86_64'
      || record.kvmApiVersion !== 12 || record.kvmVmCreated !== true) throw new Error('SSH host does not meet capacity requirements.');
    return { schemaVersion: 'treeseed.ssh-host-preflight/v1', os: 'ubuntu', version: '26.04', architecture: 'x86_64',
      kvmApiVersion: 12, kvmVmCreated: true, hostKeyFingerprint: selected.fingerprint, admission: 'kata-acceptance-required' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
