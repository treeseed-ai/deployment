// Temporary maintenance payload; removed after the accepted cutover, never a startup hook.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { convertProviderCustody } from './provider-custody.js';

const root='/data',planPath=join(root,'.provider-custody-plan.json'),receiptPath=join(root,'.provider-custody-receipt.json');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bytes(path:string) {
  if(realpathSync(dirname(path))!==dirname(path))throw new Error();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>2097152||(stat.mode&0o022))throw new Error();return readFileSync(fd);}
  finally{closeSync(fd);}
}
const read=(path:string)=>bytes(path).toString('utf8');
function writePrivate(path:string,value:unknown) {
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
}
function inventory() {
  const manifest=parse(read('/config/provider.yaml'));
  if(manifest.schemaVersion!==5||typeof manifest.identity?.privateKeyRef!=='string')throw new Error();
  const refs=new Set<string>([manifest.identity.privateKeyRef]);
  for(const c of manifest.connections??[])if(c.membershipCredentialRef)refs.add(c.membershipCredentialRef);
  const overlay=join(root,'connections.yaml');
  if(existsSync(overlay)) {
    const connections=parse(read(overlay));if(!Array.isArray(connections)||connections.length>128)throw new Error();
    for(const c of connections)if(c.membershipCredentialRef)refs.add(c.membershipCredentialRef);
  }
  if((manifest.credentialProfiles??[]).length)throw new Error(); // additional custody requires an explicit inventory contract
  const states=join(root,'connections');
  if(existsSync(states)) {
    const names=readdirSync(states);if(names.length>128)throw new Error();
    for(const name of names.filter(n=>/^[a-zA-Z0-9_.-]+\.json$/u.test(n))) {
      const state=JSON.parse(read(join(states,name)));
      if(state.generatedCredentialRef)refs.add(state.generatedCredentialRef);
    }
  }
  const records=[...refs].sort().map(ref=>{
    if(!/^data:\/\/[a-zA-Z0-9][a-zA-Z0-9_.\/-]*$/u.test(ref)||ref.slice(7).split('/').some(p=>!p||p==='.'||p==='..'))throw new Error();
    const source=join(root,ref.slice(7));
    const backup=join(root,'custody-recovery',`${createHash('sha256').update(ref).digest('hex')}.envelope`);
    const raw=read(existsSync(source)?source:backup),e=JSON.parse(raw);
    if(e.schemaVersion!=='treeseed.encrypted-envelope/v1'||e.aad?.resourceId!==ref||!Number.isSafeInteger(e.keyVersion))throw new Error();
    return {ref,keyVersion:e.keyVersion,digest:createHash('sha256').update(raw).digest('hex')};
  });
  const plan={identityRef:manifest.identity.privateKeyRef as string,records};
  return {...plan,digest:digest(plan)};
}
function status() {
  const plan=JSON.parse(read(planPath));
  const receipt=existsSync(receiptPath)?JSON.parse(read(receiptPath)):null;
  const failures=['convert','convert-retired-development-v1'].flatMap(phase=>{
    const file=join(root,`.provider-custody-failure-${phase}.json`);if(!existsSync(file))return [];
    const failure=JSON.parse(read(file));
    const stage=['preconditions','source-read','source-decrypt','destination-read','identity','backup','destination-write','retire','inventory-or-input'].includes(failure.stage)?failure.stage:'unknown';
    return [{phase,stage}];
  });
  return {ok:true,inventoryDigest:plan.digest,records:plan.records.length,
    failures,
    converted:receipt?.converted??null,identityPreserved:receipt?.identityPreserved===true,
    fingerprint:typeof receipt?.fingerprint==='string'&&/^sha256:[A-Za-z0-9_-]{43}$/u.test(receipt.fingerprint)?receipt.fingerprint:null};
}
try {
  const phase=process.argv[2];if(!['inventory','convert','convert-retired-development-v1'].includes(phase??''))throw new Error();
  const current=inventory();
  if(existsSync(planPath)){if(JSON.parse(read(planPath)).digest!==current.digest)throw new Error();}
  else if(phase==='inventory')writePrivate(planPath,current);
  else throw new Error();
  if(phase!=='inventory') {
    const versions=new Set(current.records.map(r=>r.keyVersion));if(versions.size!==1)throw new Error();
    const osKey=bytes('/run/provider-key');
    // Explicit one-time source selection, never an automatic key fallback.
    // Destination custody always uses the current OS-sealed key.
    const sourceKey=phase==='convert-retired-development-v1'?Buffer.from('treeseed-development-provider-credential-kek'):undefined;
    try {
      const receipt=convertProviderCustody({root,refs:current.records.map(r=>r.ref),identityRef:current.identityRef,
        osKey,...(sourceKey?{sourceKey}:{}),keyVersion:current.records[0]!.keyVersion,quiesced:true});
      if(existsSync(receiptPath)) {
        const prior=JSON.parse(read(receiptPath));
        if(prior.fingerprint!==receipt.fingerprint||prior.records!==receipt.records||!prior.identityPreserved)throw new Error();
      }else writePrivate(receiptPath,receipt);
      process.stdout.write(JSON.stringify({ok:true,identityPreserved:true,records:receipt.records})+'\n');
    }finally{osKey.fill(0);sourceKey?.fill(0);}
  } else {
    createServer((request,response)=>{
      if(request.method!=='GET'||request.url!=='/status'){response.writeHead(404).end();return;}
      try{response.setHeader('content-type','application/json');response.end(JSON.stringify(status()));}
      catch{response.writeHead(503).end('{"ok":false}');}
    }).listen(19843,'0.0.0.0');
  }
}catch(error){
  const stage=(error as {stage?:string}).stage;
  const bounded=['preconditions','source-read','source-decrypt','destination-read','identity','backup','destination-write','retire'].includes(stage??'')?stage:'inventory-or-input';
  const phase=['convert','convert-retired-development-v1'].includes(process.argv[2]??'')?process.argv[2]:'inventory';
  try{writePrivate(join(root,`.provider-custody-failure-${phase}.json`),{ok:false,stage:bounded});}catch{/* never overwrite prior evidence */}
  process.stderr.write(`Provider maintenance failed at ${bounded}; original identity must not be regenerated.\n`);process.exitCode=1;
}
