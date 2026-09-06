import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { preflightSshCapacityHost, sshHostArguments, type SshHostAuthority } from '../src/infrastructure/capacity/ssh-preflight.js';
const wire = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from('ssh-ed25519'), Buffer.from([0,0,0,32]), Buffer.alloc(32, 1)]);
const host: SshHostAuthority = { address: '192.0.2.10', port: 22, username: 'root', elevation: 'root', hostPublicKey: `ssh-ed25519 ${wire.toString('base64')}` };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() { const runtimeDirectory = mkdtempSync(join(tmpdir(), 'ssh-host-test-')); roots.push(runtimeDirectory);
 return { host, runtimeDirectory, privateKey: Buffer.from('synthetic-private-key'), authorizeDestination: vi.fn(async () => true) }; }
it('pins host identity, excludes local SSH configuration/agent, and never puts keys in arguments', async () => {
 const input = fixture();
 const result = await preflightSshCapacityHost({ ...input, run: (args, script) => {
  expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('IdentityAgent=none'); expect(args).toContain('/dev/null');
  expect(args.join(' ')).not.toContain('synthetic-private-key'); expect(script).toContain('0xAE01');
  const key = args[args.indexOf('-i') + 1]!; expect(statSync(key).mode & 0o777).toBe(0o600);
  return { status: 0, stdout: JSON.stringify({ os:'ubuntu',version:'26.04',architecture:'x86_64',kvmApiVersion:12,kvmVmCreated:true }) };
 } });
 expect(result.admission).toBe('kata-acceptance-required'); expect(readdirSync(input.runtimeDirectory)).toEqual([]);
});
it('denies unapproved destinations before using credentials', async () => {
 const input = fixture(), run = vi.fn();
 await expect(preflightSshCapacityHost({...input,authorizeDestination:async()=>false,run})).rejects.toThrow('deployment-authorized');
 expect(run).not.toHaveBeenCalled(); expect(readdirSync(input.runtimeDirectory)).toEqual([]);
});
it.each(['-oProxyCommand=evil','example.com','fe80::1%eth0'])('rejects unsafe or unresolved destination %s', address => {
 expect(()=>sshHostArguments({...host,address},'/run/treeseed')).toThrow();
});
it.each([null, 1])('cleans up credentials on SSH failure (%s) and omits remote output', async status => {
 const input=fixture(); await expect(preflightSshCapacityHost({...input,run:()=>({status,stdout:'sensitive remote output'})})).rejects.toThrow('preflight failed');
 expect(readdirSync(input.runtimeDirectory)).toEqual([]);
});
it('does not accept a device-presence-only probe or malformed host key', async () => {
 expect(()=>sshHostArguments({...host,hostPublicKey:'ssh-ed25519 AAAA'},'/run/treeseed')).toThrow();
 await expect(preflightSshCapacityHost({...fixture(),run:()=>({status:0,stdout:'{"kvmPresent":true}'})})).rejects.toThrow('requirements');
});
