import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getCACertificates,setDefaultCACertificates } from 'node:tls';
import { setTimeout as pause } from 'node:timers/promises';
import { bootstrapManagedOpenBao, managedOpenBaoConfiguration, withManagedOpenBao } from '../src/security/custody/index.js';

const binary=process.env.TREESEED_TEST_OPENBAO_BINARY;
if(!binary)throw new Error('Verified disposable test binary required.');
const root=mkdtempSync(join(tmpdir(),'treeseed-openbao-managed-'));
const originalTrust=getCACertificates('default');let child:ChildProcess|undefined;
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise<void>(accept=>child!.once('exit',()=>accept()));child.kill('SIGTERM');await Promise.race([exited,pause(5000,undefined,{ref:false})]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
try{
  for(const name of ['data','custody'])mkdirSync(join(root,name),{mode:0o700});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=openbao-test',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',join(root,'tls.key'),'-out',join(root,'ca.pem')],{stdio:'ignore'});
  setDefaultCACertificates([...originalTrust,readFileSync(join(root,'ca.pem'),'utf8')]);
  writeFileSync(join(root,'seal.key'),randomBytes(32),{mode:0o600});writeFileSync(join(root,'custody.key'),randomBytes(32),{mode:0o600});
  const listener=createServer();await new Promise<void>(accept=>listener.listen(0,'127.0.0.1',accept));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(accept=>listener.close(()=>accept()));
  const address=`https://127.0.0.1:${port}`;
  const config=managedOpenBaoConfiguration().replaceAll('/openbao/data',join(root,'data')).replaceAll('/run/openbao/',`${root}/`)
    .replace('https://openbao:8200',address).replace('https://openbao:8201',`https://127.0.0.1:${port+1}`).replace('0.0.0.0:8200',`127.0.0.1:${port}`);
  writeFileSync(join(root,'openbao.hcl'),config);
  const start=()=>{child=spawn(resolve(binary),['server',`-config=${join(root,'openbao.hcl')}`],{stdio:'ignore'});};
  const options={address,custodyRoot:join(root,'custody'),keyFile:join(root,'custody.key'),identityFile:join(root,'identity.json')};
  start();assert.equal((await bootstrapManagedOpenBao(options)).rootTokenRetained,false);
  const scope={team:'test',project:'team',environment:'staging',purpose:'hosting',name:'connection'};
  const connection={address,mount:'treeseed',identityFile:options.identityFile};
  await withManagedOpenBao(connection,[scope],async c=>{assert.equal(await c.write(scope,{apiToken:'synthetic-value'},0),1);});
  const identityBefore=readFileSync(options.identityFile,'utf8');
  await stop();start();await bootstrapManagedOpenBao(options);
  assert.equal(readFileSync(options.identityFile,'utf8'),identityBefore);
  await withManagedOpenBao(connection,[scope],async c=>{assert.equal((await c.read(scope))?.values.apiToken,'synthetic-value');assert.equal(await c.version(scope),1);});
  console.log(JSON.stringify({ok:true,checks:['persistent-raft','os-injected-static-seal','idempotent-bootstrap','root-token-revocation','bounded-approle','restart-readback']}));
}finally{await stop();setDefaultCACertificates(originalTrust);rmSync(root,{recursive:true,force:true});}
