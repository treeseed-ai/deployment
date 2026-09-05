import { createHash, createHmac } from 'node:crypto';

type Connection = {providerId:string;nonSecretConfig:Record<string,unknown>};
const failure=()=>new Error('Managed service credential validation failed.');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const hmac=(key:Buffer|string,value:string)=>createHmac('sha256',key).update(value).digest();
function r2Request(connection:Connection,values:Record<string,string>) {
  const account=String(connection.nonSecretConfig.accountId??''),bucket=String(connection.nonSecretConfig.stateBucket??'');
  if(!/^[a-f0-9]{32}$/u.test(account)||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)
    ||!values.accessKeyId||!values.secretAccessKey)throw failure();
  const host=`${account}.r2.cloudflarestorage.com`,path=`/${bucket}`;
  const time=new Date().toISOString().replace(/[:-]|\.\d{3}/gu,''),day=time.slice(0,8);
  const headers:Record<string,string>={host,'x-amz-content-sha256':hash(''),'x-amz-date':time};
  if(values.sessionToken)headers['x-amz-security-token']=values.sessionToken;
  const names=Object.keys(headers).sort(), signed=names.join(';');
  const canonical=['HEAD',path,'',names.map(n=>`${n}:${headers[n]!.trim()}`).join('\n')+'\n',signed,hash('')].join('\n');
  const scope=`${day}/auto/s3/aws4_request`;
  const key=hmac(hmac(hmac(hmac(`AWS4${values.secretAccessKey}`,day),'auto'),'s3'),'aws4_request');
  const signature=createHmac('sha256',key).update(`AWS4-HMAC-SHA256\n${time}\n${scope}\n${hash(canonical)}`).digest('hex');key.fill(0);
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${values.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return {url:`https://${host}${path}`,init:{method:'HEAD',headers}};
}
/** Read-only validation. No provider body, token or credential is returned or logged. */
export async function validateManagedServiceCredentials(connection:Connection,profileId:string,values:Record<string,string>,fetchImpl:typeof fetch=fetch):Promise<void> {
  try {
    if(profileId==='opentofu-state-encryption') {
      if(connection.providerId!=='cloudflare'||!/^[a-f0-9]{64}$/u.test(values.stateEncryptionKey??''))throw failure();
      return; // local encryption-key format, not an upstream connection claim
    }
    let url:string,init:RequestInit={},inspect:((body:any)=>boolean)|undefined;
    if(connection.providerId==='cloudflare'&&profileId==='s3-state-session')({url,init}=r2Request(connection,values));
    else if(connection.providerId==='cloudflare') {
      if(!values.apiToken)throw failure();
      url='https://api.cloudflare.com/client/v4/user/tokens/verify';init.headers={authorization:`Bearer ${values.apiToken}`};
      inspect=body=>body.success===true&&body.result?.status==='active';
    } else if(connection.providerId==='railway') {
      if(!values.apiToken)throw failure();
      url='https://backboard.railway.app/graphql/v2';init={method:'POST',headers:{authorization:`Bearer ${values.apiToken}`,'content-type':'application/json'},body:JSON.stringify({query:'query ServiceConnectionValidation { me { id } }'})};
      inspect=body=>!body.errors?.length&&typeof body.data?.me?.id==='string';
    } else if(connection.providerId==='github') {
      if(!values.accessToken)throw failure();
      url='https://api.github.com/user';init.headers={authorization:`Bearer ${values.accessToken}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'treeseed-service-validation'};
      inspect=body=>typeof body.id==='number';
    } else throw failure();
    const response=await fetchImpl(url,{...init,redirect:'error',signal:AbortSignal.timeout(15_000)});
    if(!response.ok){await response.body?.cancel();throw failure();}
    if(!inspect){await response.body?.cancel();return;}
    const reader=response.body?.getReader();if(!reader)throw failure();
    let length=0;const chunks:Uint8Array[]=[];
    try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>65_536)throw failure();chunks.push(value);}}
    finally{await reader.cancel();}
    if(!inspect(JSON.parse(Buffer.concat(chunks).toString('utf8'))))throw failure();
  } catch {throw failure();}
}
