import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OsSecretCustody, managedOpenBaoServices, managedOpenBaoConfiguration } from '../src/security/custody/index.js';
const roots:string[]=[];
const root=()=>{const r=mkdtempSync(join(tmpdir(),'treeseed-os-test-'));roots.push(r);return r;};
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const scope={team:'host',project:'cli',environment:'local',purpose:'oauth',name:'session'};
describe('OS custody lifecycle',()=>{
  function command(){const key=randomBytes(32);return vi.fn((args:string[],input:Buffer)=>args[0]==='encrypt'?Buffer.from('opaque-os-ciphertext'):Buffer.from(key));}
  it('uses OS sealing only and enforces lock across separate CLI instances',()=>{
    const directory=root(),run=command(),a=new OsSecretCustody(directory,true,run);
    a.run(c=>c.write(scope,{accessToken:'synthetic-token'},0),true);
    const b=new OsSecretCustody(directory,true,run);expect(b.run(c=>c.read(scope))?.values.accessToken).toBe('synthetic-token');
    a.lock();expect(b.locked).toBe(true);const before=run.mock.calls.length;
    expect(()=>b.run(c=>c.read(scope))).toThrow('locked');expect(run.mock.calls.length).toBe(before);
    b.unlock();expect(a.run(c=>c.read(scope))?.version).toBe(1);
    expect(run.mock.calls[0]![0]).toContain('--user');expect(run.mock.calls[1]![0]).toContain('--refuse-null');
    expect(readFileSync(join(directory,'custody.cred'),'utf8')).toBe('opaque-os-ciphertext');
    for(const name of readdirSync(directory))expect(readFileSync(join(directory,name)).includes('synthetic-token')).toBe(false);
  });
  it('does not invent a replacement OS key when ciphertext exists',()=>{
    const directory=root(),store=new OsSecretCustody(directory,false,command());
    store.run(c=>c.write(scope,{token:'test'},0),true);unlinkSync(join(directory,'custody.cred'));
    expect(()=>store.run(c=>c.read(scope),true)).toThrow('os_credential_unavailable');
  });
  it('never falls back when the OS facility is unavailable',()=>{
    const store=new OsSecretCustody(root(),true,()=>{throw new Error('sensitive diagnostic');});
    expect(()=>store.run(c=>c.read(scope),true)).toThrow('os_credential_unavailable');
  });
  it('renders a private persistent core service, not a dev-mode or external vault',()=>{
    const config=managedOpenBaoConfiguration(),services=managedOpenBaoServices(`treeseed/api@sha256:${'a'.repeat(64)}`);
    expect(config).toContain('storage "raft"');expect(config).toContain('file:///run/openbao/seal.key');
    expect(services.openbao).not.toHaveProperty('ports');expect(services.openbao.command).not.toContain('-dev');
    expect(services['openbao-initialize'].volumes.some(v=>v.target==='/openbao/custody')).toBe(true);
  });
});
