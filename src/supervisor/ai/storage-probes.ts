/** Fixed acceptance programs run inside managed AI images, never caller-supplied code. */
export const nodeStorageProbe = String.raw`
import {randomUUID} from 'node:crypto';
import {storageCustodyFromEnvironment,ManagedArtifactStore} from '/app/packages/common/dist/index.js';
import {createRequire} from 'node:module';
const require=createRequire('/app/packages/common/package.json');
const {S3Client,HeadObjectCommand,DeleteObjectCommand}=require('@aws-sdk/client-s3');
const custody=storageCustodyFromEnvironment(),storeId='managed-'+process.env.AI_STORAGE_SERVICE;
const store=new ManagedArtifactStore(storeId,custody),key='.treeseed-acceptance/'+randomUUID()+'/probe';
const bytes=Buffer.from('treeseed-vault-storage-acceptance/v1');
let created=false,phase='write',ok=false,cleanup=true;
const client=lease=>new S3Client({endpoint:lease.endpoint,credentials:lease.credentials,region:'auto',forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
async function denied(lease,objectKey){const c=client(lease);try{await c.send(new HeadObjectCommand({Bucket:lease.bucket,Key:objectKey}));throw Error('Isolation failed');}catch(e){if(e?.$metadata?.httpStatusCode!==403)throw Error('Expected provider denial');}finally{c.destroy();}}
try{
 await store.put(key,bytes);created=true;phase='read';
 if(Buffer.compare(Buffer.from(await store.bytes(key)),bytes)!==0)throw Error();
 phase='list';if(!(await store.keys(key)).includes(key))throw Error();
 phase='object-isolation';const read=await custody(storeId,'read',key);await denied(read,read.objectKey+'-sibling');
 phase='team-isolation';await denied(read,read.objectKey.replace(process.env.AI_TEAM_ID,randomUUID()));
 phase='action-isolation';await denied(await custody(storeId,'write',key),read.objectKey);
 phase='workload-isolation';let rejected=false;try{await custody('managed-lab','read',key);}catch{rejected=true;}if(!rejected)throw Error();
 ok=true;phase='complete';
}catch{}finally{if(created){try{const lease=await custody(storeId,'delete',key),c=client(lease);try{await c.send(new DeleteObjectCommand({Bucket:lease.bucket,Key:lease.objectKey}));}finally{c.destroy();}}catch{cleanup=false;}}}
console.log(JSON.stringify({ok:ok&&cleanup,phase,cleanup,key}));
`;

export const pythonStorageProbe = String.raw`
import json,uuid
from common.storage_custody import storage_client,storage_lease
key='.treeseed-acceptance/'+str(uuid.uuid4())+'/probe'
store='managed-training';body=b'treeseed-vault-storage-acceptance/v1'
created=False;ok=False;cleanup=True;phase='write'
def call(action,fn):
    client,lease=storage_client(store,action,key)
    try:return fn(client,lease)
    finally:client.close()
try:
    call('write',lambda c,l:c.put_object(Bucket=l['bucket'],Key=l['objectKey'],Body=body,IfNoneMatch='*'));created=True;phase='read'
    def read(c,l):
        stream=c.get_object(Bucket=l['bucket'],Key=l['objectKey'])['Body']
        try:return stream.read(1024)
        finally:stream.close()
    if call('read',read)!=body:raise ValueError()
    phase='list'
    if not call('list',lambda c,l:any(x['Key']==l['objectKey'] for x in c.list_objects_v2(Bucket=l['bucket'],Prefix=l['objectKey']).get('Contents',[]))):raise ValueError()
    phase='object-isolation'
    def denied(c,l):
        try:c.head_object(Bucket=l['bucket'],Key=l['objectKey']+'-sibling')
        except Exception as e:
            if getattr(e,'response',{}).get('ResponseMetadata',{}).get('HTTPStatusCode')==403:return
        raise ValueError()
    call('read',denied);ok=True;phase='complete'
except Exception:pass
finally:
    if created:
        try:call('delete',lambda c,l:c.delete_object(Bucket=l['bucket'],Key=l['objectKey']))
        except Exception:cleanup=False
print(json.dumps(dict(ok=ok and cleanup,phase=phase,cleanup=cleanup,key=key)))
`;
