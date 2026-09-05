import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';
import { LocalSecretCustody } from '../src/security/custody/local.js';
import { convertProviderCustody } from '../scripts/maintenance/provider-custody.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'treeseed-custody-conversion-'));roots.push(root);
  const osKey=randomBytes(32),key=createHash('sha256').update(osKey).digest();
  const codec=new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential',{id:'provider-credentials',version:1,key}));
  const identity=JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}));
  const refs=['data://identity-v3.json','data://membership.json'];
  const write=(ref:string,value:string,aadRef=ref)=>writeFileSync(join(root,ref.slice(7)),JSON.stringify(codec.encrypt(value,
    {purpose:'provider-credential',teamId:'provider-local',resourceType:'provider-secret',resourceId:aadRef,schemaVersion:'treeseed.encrypted-envelope/v1'})),{mode:0o600});
  write(refs[0]!,identity);write(refs[1]!,'synthetic-membership-secret');
  return {root,key,identity,write,input:{root,osKey,refs,identityRef:refs[0]!,keyVersion:1,quiesced:true as const}};
}
describe('maintenance-only provider conversion',()=>{
  it('preserves signing identity and membership, keeps encrypted recovery and replays as noop',()=>{
    const f=fixture(),receipt=convertProviderCustody(f.input);
    expect(receipt).toMatchObject({identityPreserved:true,records:2,converted:2,recoveryRetained:true});
    expect(JSON.stringify(receipt)).not.toContain(JSON.parse(f.identity).d);
    expect(existsSync(join(f.root,'identity-v3.json'))).toBe(false);
    const store=new LocalSecretCustody(join(f.root,'custody'));store.unlock(f.key);
    const get=(ref:string)=>store.read({team:'host',project:'agent',environment:'local',purpose:'provider',name:createHash('sha256').update(ref).digest('hex')});
    expect(get(f.input.identityRef)?.values.value).toBe(f.identity);
    expect(get(f.input.refs[1]!)?.values.value).toBe('synthetic-membership-secret');store.lock();
    expect(convertProviderCustody(f.input)).toEqual({...receipt,converted:0});
  });
  it('rejects wrong keys and wrong resource AAD before retiring originals',()=>{
    const f=fixture();expect(()=>convertProviderCustody({...f.input,osKey:randomBytes(32)})).toThrow('conversion failed');
    f.write(f.input.refs[1]!,'synthetic','data://different.json');
    expect(()=>convertProviderCustody(f.input)).toThrow('conversion failed');
    expect(existsSync(join(f.root,'identity-v3.json'))).toBe(true);
  });
  it('rejects plaintext, path traversal, symlinks and unquiesced execution',()=>{
    const f=fixture();
    expect(()=>convertProviderCustody({...f.input,quiesced:false as true})).toThrow();
    expect(()=>convertProviderCustody({...f.input,refs:[f.input.identityRef,'data://../escape']})).toThrow();
    const source=join(f.root,'membership.json');rmSync(source);symlinkSync(join(f.root,'identity-v3.json'),source);
    expect(()=>convertProviderCustody(f.input)).toThrow();rmSync(source);writeFileSync(source,'plaintext',{mode:0o600});
    expect(()=>convertProviderCustody(f.input)).toThrow();
  });
  it('never overwrites conflicting destination custody',()=>{
    const f=fixture();convertProviderCustody(f.input);
    f.write(f.input.refs[1]!,'different-value');
    expect(()=>convertProviderCustody(f.input)).toThrow();
    expect(readFileSync(join(f.root,'membership.json'),'utf8')).not.toContain('different-value');
  });
  it('does not include maintenance code in runtime packaging',()=>{
    const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
    expect(pkg.files).not.toContain('dist/scripts/**');
    expect(JSON.stringify(pkg.exports)).not.toContain('maintenance');
  });
});
