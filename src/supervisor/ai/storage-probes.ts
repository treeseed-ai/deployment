/** Fixed acceptance programs run inside managed AI images, never caller-supplied code. */
export const nodeStorageProbe = String.raw`
import {randomUUID} from 'node:crypto';
setTimeout(()=>process.exit(124),75000).unref();
import {storageCustodyFromEnvironment,ManagedArtifactStore} from '/app/packages/common/dist/index.js';
import {createRequire} from 'node:module';
const require=createRequire('/app/packages/common/package.json');
const {S3Client,HeadObjectCommand,DeleteObjectCommand}=require('@aws-sdk/client-s3');
const diagnostics={};const originalFetch=globalThis.fetch;
const originalSend=S3Client.prototype.send;S3Client.prototype.send=async function(...args){try{return await originalSend.apply(this,args);}catch(error){if(['InvalidArgument','InvalidToken','ExpiredToken','AccessDenied','SignatureDoesNotMatch','InvalidAccessKeyId','NotImplemented','InvalidRequest','BadDigest'].includes(error.name))diagnostics.providerCode=error.name;throw error;}};
globalThis.fetch=async(...args)=>{try{const response=await originalFetch(...args);diagnostics.brokerStatus=response.status;if(!response.ok){const body=await response.clone().json().catch(()=>({}));if(['ai_storage_proof_invalid','ai_storage_node_unavailable','ai_storage_project_unavailable','ai_storage_binding_unavailable','ai_storage_proof_unavailable','ai_storage_access_changed'].includes(body.code))diagnostics.brokerCode=body.code;}return response;}catch(error){const code=error?.cause?.code??error?.code;if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code))diagnostics.transportCode=code;throw error;}};
const custody=storageCustodyFromEnvironment(),storeId='managed-'+process.env.AI_STORAGE_SERVICE;
const store=new ManagedArtifactStore(storeId,custody),key='.treeseed-acceptance/'+randomUUID()+'/probe';
const bytes=Buffer.from('treeseed-vault-storage-acceptance/v1');
let created=false,phase='write',ok=false,cleanup=true;
const client=lease=>new S3Client({endpoint:lease.endpoint,credentials:lease.credentials,region:'auto',forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
async function denied(lease,objectKey){const c=client(lease);try{await c.send(new HeadObjectCommand({Bucket:lease.bucket,Key:objectKey}));throw Error('Isolation failed');}catch(e){if(e?.$metadata?.httpStatusCode!==403)throw Error('Expected provider denial');}finally{c.destroy();}}
try{
 created=true;await store.put(key,bytes);phase='read';
 if(Buffer.compare(Buffer.from(await store.bytes(key)),bytes)!==0)throw Error();
 phase='list';if(!(await store.keys(key)).includes(key))throw Error();
 phase='object-isolation';const read=await custody(storeId,'read',key);await denied(read,read.objectKey+'-sibling');
 phase='team-isolation';await denied(read,read.objectKey.replace(process.env.AI_TEAM_ID,randomUUID()));
 phase='action-isolation';await denied(await custody(storeId,'write',key),read.objectKey);
 phase='workload-isolation';let rejected=false;try{await custody('managed-lab','read',key);}catch{rejected=true;}if(!rejected)throw Error();
 ok=true;phase='complete';
}catch(error){const status=error?.$metadata?.httpStatusCode;if(Number.isInteger(status))diagnostics.providerStatus=status;}finally{if(created){try{const lease=await custody(storeId,'delete',key),c=client(lease);try{await c.send(new DeleteObjectCommand({Bucket:lease.bucket,Key:lease.objectKey}));}finally{c.destroy();}}catch{cleanup=false;}}}
console.log(JSON.stringify({ok:ok&&cleanup,phase,cleanup,key,diagnostics}));
`;

export const pythonStorageProbe = String.raw`
import json,uuid,os,signal
signal.signal(signal.SIGALRM,lambda *_:os._exit(124));signal.alarm(75)
from common.storage_custody import storage_client,storage_lease
key='.treeseed-acceptance/'+str(uuid.uuid4())+'/probe'
store='managed-training';body=b'treeseed-vault-storage-acceptance/v1'
created=False;ok=False;cleanup=True;phase='write'
def call(action,fn):
    client,lease=storage_client(store,action,key)
    try:return fn(client,lease)
    finally:client.close()
try:
    created=True;call('write',lambda c,l:c.put_object(Bucket=l['bucket'],Key=l['objectKey'],Body=body,IfNoneMatch='*'));phase='read'
    def read(c,l):
        stream=c.get_object(Bucket=l['bucket'],Key=l['objectKey'])['Body']
        try:return stream.read(1024)
        finally:stream.close()
    if call('read',read)!=body:raise ValueError()
    phase='list'
    if not call('list',lambda c,l:any(x['Key']==l['objectKey'] for x in c.list_objects_v2(Bucket=l['bucket'],Prefix=l['objectKey']).get('Contents',[]))):raise ValueError()
    phase='object-isolation'
    def denied(c,l,target):
        try:c.head_object(Bucket=l['bucket'],Key=target)
        except Exception as e:
            if getattr(e,'response',{}).get('ResponseMetadata',{}).get('HTTPStatusCode')==403:return
        raise ValueError()
    call('read',lambda c,l:denied(c,l,l['objectKey']+'-sibling'))
    phase='team-isolation';call('read',lambda c,l:denied(c,l,l['objectKey'].replace(os.environ['AI_TEAM_ID'],str(uuid.uuid4()))))
    phase='action-isolation';call('write',lambda c,l:denied(c,l,l['objectKey']))
    phase='workload-isolation';rejected=False
    try:storage_lease('managed-lab','read',key)
    except Exception:rejected=True
    if not rejected:raise ValueError()
    ok=True;phase='complete'
except Exception:pass
finally:
    if created:
        try:call('delete',lambda c,l:c.delete_object(Bucket=l['bucket'],Key=l['objectKey']))
        except Exception:cleanup=False
print(json.dumps(dict(ok=ok and cleanup,phase=phase,cleanup=cleanup,key=key)))
`;
