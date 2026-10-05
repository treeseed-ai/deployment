import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateManagedServiceCredentials } from '../src/security/services/validate.js';
const cloudflare={providerId:'cloudflare',nonSecretConfig:{accountId:'a'.repeat(32),stateBucket:'state-test'}};
test('R2 validation signs only a bounded private read, including optional session token',async()=>{
  const fetchImpl=(async(url:string,init:RequestInit)=>{
    assert.equal(url,`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/state-test`);
    assert.equal(init.method,'HEAD');assert.equal(init.redirect,'error');assert.ok(init.signal);
    const headers=init.headers as Record<string,string>;
    assert.equal(headers['x-amz-security-token'],'synthetic-session');
    assert.match(headers.authorization!,/^AWS4-HMAC-SHA256 Credential=synthetic-id\//);
    assert.ok(!JSON.stringify(init).includes('synthetic-secret'));return new Response(null,{status:200});
  }) as typeof fetch;
  await validateManagedServiceCredentials(cloudflare,'s3-state-session',{accessKeyId:'synthetic-id',secretAccessKey:'synthetic-secret',sessionToken:'synthetic-session'},fetchImpl);
});
test('provider errors and oversized replies are redacted; failed credentials are never accepted',async()=>{
  for(const response of [new Response('synthetic-secret',{status:403}),new Response('x'.repeat(70_000)),Response.json({success:false})])
    await assert.rejects(validateManagedServiceCredentials(cloudflare,'cloudflare-runtime',{apiToken:'synthetic-secret'},async()=>response),{message:'Managed service credential validation failed.'});
  await assert.rejects(validateManagedServiceCredentials({...cloudflare,nonSecretConfig:{accountId:'https://evil',stateBucket:'state'}},'s3-state-session',{accessKeyId:'id',secretAccessKey:'secret'},async()=>{throw Error('must not fetch');}));
});
test('validates encryption key locally and verifies actual provider response semantics',async()=>{
  await validateManagedServiceCredentials(cloudflare,'opentofu-state-encryption',{stateEncryptionKey:'a'.repeat(64)},async()=>{throw Error('must not fetch');});
  await assert.rejects(validateManagedServiceCredentials(cloudflare,'opentofu-state-encryption',{stateEncryptionKey:'bad'}));
  await validateManagedServiceCredentials(cloudflare,'cloudflare-runtime',{apiToken:'synthetic'},async()=>Response.json({success:true,result:{status:'active'}}));
  await validateManagedServiceCredentials({providerId:'railway',nonSecretConfig:{}},'railway-workspace',{apiToken:'synthetic'},async()=>Response.json({data:{me:{id:'user'}}}));
  await assert.rejects(validateManagedServiceCredentials({providerId:'railway',nonSecretConfig:{}},'railway-workspace',{apiToken:'synthetic'},async()=>Response.json({data:{me:null}})));
});
