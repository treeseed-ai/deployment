// One-time maintenance only. Not exported or included in the Deployment runtime package.
import { constants, closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider, encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import { LocalSecretCustody } from '../../src/security/custody/local.js';

const fail = () => new Error('Provider custody conversion failed; retain recovery material and inspect the bounded maintenance operation.');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (ref: string) => ({team:'host',project:'agent',environment:'local',purpose:'provider',name:hash(ref)});
function privateFile(path: string) {
  if(realpathSync(dirname(path)) !== dirname(path))throw fail();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.uid!==process.getuid?.()||stat.size>2*1024*1024)throw fail();
    return readFileSync(fd);
  }finally{closeSync(fd);}
}
function sync(path: string) { const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);} }
function identityFingerprint(value: string) {
  const jwk=JSON.parse(value);
  if(jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||typeof jwk.d!=='string')throw fail();
  const key=createPrivateKey({key:jwk,format:'jwk'}), publicKey=createPublicKey(key);
  const publicJwk=publicKey.export({format:'jwk'});
  if(publicJwk.x!==jwk.x)throw fail();
  const challenge=Buffer.from('treeseed-provider-custody-continuity/v1');
  if(!verify(null,challenge,publicKey,sign(null,challenge,key)))throw fail();
  return `sha256:${createHash('sha256').update(JSON.stringify({crv:'Ed25519',kty:'OKP',x:publicJwk.x})).digest('base64url')}`;
}

/** Caller must stop both provider processes and freeze the exact reference inventory first.
 * Existing encrypted originals remain in owner-only recovery custody, never in the workspace.
 * This does not enroll, revoke, rotate identities or contact the control plane.
 */
export function convertProviderCustody(input: {
  root: string; refs: string[]; identityRef: string; osKey: Uint8Array; sourceKey?: Uint8Array; keyVersion: number; quiesced: true;
}) {
  let key: Buffer|undefined, sourceKey:Buffer|undefined, custody: LocalSecretCustody|undefined, lock: number|undefined;
  let stage='preconditions';
  const retained: Array<{ref:string;source:string;backup:string;value:string;encoded:Buffer}> = [];
  let lockPath='';
  try {
    if(input.quiesced!==true||resolve(input.root)!==input.root||input.root==='/'||input.refs.length<1||input.refs.length>128
      ||new Set(input.refs).size!==input.refs.length||!input.refs.includes(input.identityRef)
      ||input.osKey.byteLength<24||input.osKey.byteLength>4096|| (input.sourceKey&&(input.sourceKey.byteLength<24||input.sourceKey.byteLength>4096)) ||!Number.isSafeInteger(input.keyVersion)||input.keyVersion<1)throw fail();
    // Reuse the store's owner/ancestry checks without writing to the source root.
    new LocalSecretCustody(input.root);
    for(const ref of input.refs) {
      if(!/^data:\/\/[A-Za-z0-9][A-Za-z0-9_.\/-]*$/u.test(ref)
        ||ref.slice(7).split('/').some(p=>!p||p==='.'||p==='..'||p==='custody'||p==='custody-recovery'))throw fail();
    }
    lockPath=join(input.root,'.provider-custody-cutover.lock');
    lock=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const target=join(input.root,'custody'),backupRoot=join(input.root,'custody-recovery');
    for(const directory of [target,backupRoot]) {
      if(!existsSync(directory))mkdirSync(directory,{mode:0o700});
      new LocalSecretCustody(directory);
    }
    key=createHash('sha256').update(input.osKey).digest();
    sourceKey=createHash('sha256').update(input.sourceKey??input.osKey).digest();
    custody=new LocalSecretCustody(target);custody.unlock(key);
    const codec=new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential',
      {id:'provider-credentials',version:input.keyVersion,key:sourceKey}));
    // Validate every source and destination before the first secret write.
    for(const ref of input.refs) {
      stage='source-read';
      const source=join(input.root,ref.slice(7)),backup=join(backupRoot,`${hash(ref)}.envelope`);
      const encoded=privateFile(existsSync(source)?source:backup);
      const envelope=encryptedEnvelopeSchema.parse(JSON.parse(encoded.toString('utf8')));
      const expected={purpose:'provider-credential',teamId:'provider-local',resourceType:'provider-secret',resourceId:ref,schemaVersion:'treeseed.encrypted-envelope/v1'};
      if(envelope.keyProvider!=='systemd-credential'||Object.keys(envelope.aad).length!==5
        ||Object.entries(expected).some(([k,v])=>(envelope.aad as Record<string,unknown>)[k]!==v))throw fail();
      stage='source-decrypt';const plaintext=codec.decrypt(envelope);let value:string;
      try{value=plaintext.toString('utf8');if(!value.trim()||!Buffer.from(value).equals(plaintext))throw fail();}finally{plaintext.fill(0);}
      stage='destination-read';const current=custody.read(scope(ref));
      if(current ? current.values.value!==value : custody.version(scope(ref))!==0)throw fail();
      if(existsSync(backup)&&!privateFile(backup).equals(encoded))throw fail();
      retained.push({ref,source,backup,value,encoded});
    }
    stage='identity';const fingerprint=identityFingerprint(retained.find(r=>r.ref===input.identityRef)!.value);
    stage='backup';
    for(const item of retained) {
      if(!existsSync(item.backup)){copyFileSync(item.source,item.backup,constants.COPYFILE_EXCL);sync(item.backup);}
      if(!privateFile(item.backup).equals(item.encoded))throw fail();
    }
    sync(backupRoot);
    let converted=0;
    stage='destination-write';
    for(const item of retained) {
      if(custody.version(scope(item.ref))===0){custody.write(scope(item.ref),{value:item.value},0);converted++;}
      if(custody.read(scope(item.ref))?.values.value!==item.value)throw fail();
    }
    if(identityFingerprint(custody.read(scope(input.identityRef))!.values.value!)!==fingerprint)throw fail();
    // Retire only unchanged exact inventoried files after encrypted recovery and read-back.
    stage='retire';for(const item of retained)if(existsSync(item.source)) {
      if(!privateFile(item.source).equals(item.encoded))throw fail();
      unlinkSync(item.source);sync(dirname(item.source));
    }
    return {ok:true,identityPreserved:true,fingerprint,records:retained.length,converted,recoveryRetained:true};
  }catch{throw Object.assign(fail(),{stage});}
  finally {
    custody?.lock();key?.fill(0);sourceKey?.fill(0);
    for(const item of retained){item.value='';item.encoded.fill(0);}
    if(lock!==undefined){closeSync(lock);unlinkSync(lockPath);}
  }
}
