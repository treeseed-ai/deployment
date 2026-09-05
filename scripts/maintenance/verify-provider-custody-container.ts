// Disposable Actions acceptance only; never operates against a host provider directory.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';

if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Disposable Actions runner required.');
const root=mkdtempSync(join(tmpdir(),'treeseed-provider-proof-'));
chmodSync(root,0o755); // Compose configuration is public; fixture keys/data remain private.
const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
const compose=parse(readFileSync('deploy/maintenance/provider-custody.yml','utf8'));
const image=compose.services.inventory.image as string;
const file=join(root,'compose.yml'),data=join(root,'data');mkdirSync(data,{mode:0o700});
const key=randomBytes(32), codec=new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential',
  {id:'provider-credentials',version:1,key:createHash('sha256').update(key).digest()}));
const identity=JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}));
const refs=['data://identity.json','data://membership.json'];
for(const [i,ref] of refs.entries())writeFileSync(join(data,ref.slice(7)),JSON.stringify(codec.encrypt(i===0?identity:'synthetic-membership',
  {purpose:'provider-credential',teamId:'provider-local',resourceType:'provider-secret',resourceId:ref,schemaVersion:'treeseed.encrypted-envelope/v1'})),{mode:0o600});
writeFileSync(join(root,'key'),key,{mode:0o400});key.fill(0);
writeFileSync(join(root,'provider.yaml'),stringify({schemaVersion:5,identity:{privateKeyRef:refs[0]},connections:[],credentialProfiles:[]}),{mode:0o640});
writeFileSync(join(data,'connections.yaml'),stringify([{membershipCredentialRef:refs[1]}]),{mode:0o600});
for(const service of Object.values(compose.services) as Array<{volumes:Array<{source:string;target:string}>}>)for(const volume of service.volumes)
  volume.source=volume.target==='/data'?data:volume.target==='/config/provider.yaml'?join(root,'provider.yaml'):
    volume.target==='/run/provider-key'?join(root,'key'):resolve('dist');
writeFileSync(file,stringify(compose),{mode:0o644});
const run=(args:string[])=>docker(['compose','-f',file,'--project-name','treeseed-provider-custody-proof',...args]);
try {
  docker(['run','--rm','--user','0','--network','none','--entrypoint','chown','--mount',`type=bind,src=${root},dst=/fixture`,image,'-R','65532:65532','/fixture']);
  run(['up','-d','--wait','--wait-timeout','45','inventory']);
  const before=await (await fetch('http://127.0.0.1:19843/status')).json() as {records:number;identityPreserved:boolean;inventoryDigest:string};
  if(before.records!==2||before.identityPreserved)throw new Error('Inventory proof failed.');
  run(['up','-d','--wait','--wait-timeout','45','accept']);
  const after=await (await fetch('http://127.0.0.1:19843/status')).json() as typeof before;
  if(!after.identityPreserved||after.inventoryDigest!==before.inventoryDigest)throw new Error('Conversion proof failed.');
  // Actual immutable Agent reader, not a test reimplementation of the custody contract.
  const check=`const {readProviderSecret}=await import('/app/dist/provider/security/os-custody.js');
    const identity=JSON.parse(readProviderSecret('data://identity.json','/data'));
    if(identity.crv!=='Ed25519'||readProviderSecret('data://membership.json','/data')!=='synthetic-membership')process.exit(1);`;
  run(['run','--rm','--no-deps','--entrypoint','node','-e','TREESEED_PROVIDER_CREDENTIAL_KEK_FILE=/run/provider-key','convert','--input-type=module','-e',check]);
  run(['run','--rm','--no-deps','convert']); // frozen inventory + encrypted recovery => idempotent replay
  console.log(JSON.stringify({ok:true,records:2,identityPreserved:true,agentReader:true,replay:true,networklessConversion:true}));
}catch(error){
  // Fixture secrets are synthetic, but retain the same bounded diagnostic policy as live acceptance.
  process.stderr.write('Disposable provider custody container acceptance failed.\n');throw error;
}finally {
  try{run(['down','--remove-orphans']);}finally{
    docker(['run','--rm','--user','0','--network','none','--entrypoint','chown','--mount',`type=bind,src=${root},dst=/fixture`,image,'-R',`${process.getuid!()}:${process.getgid!()}`,'/fixture']);
    rmSync(root,{recursive:true,force:true});
  }
}
