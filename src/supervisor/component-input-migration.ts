import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Parser } from 'tar';
import type { Writable } from 'node:stream';
import { loadHostConfiguration } from '../core/configuration.js';
import { paths } from '../core/paths.js';
import { installedComponentRelease } from './component-release.js';
import { usesSealedComponentCredentials } from './component-ephemeral.js';
import { withApplicationBackupKey, withVerifiedGenerationBackup } from './backup.js';
import { decryptBackupStream } from './backup-stream.js';
import { postgresDocker } from './postgres-process.js';

export function assertInputMigrationProof(input:{confirmed:boolean;current:string;expected:string;archived:string;running:boolean}) {
  if(!input.confirmed || input.running || !/^[a-f0-9]{64}$/u.test(input.expected) ||
    input.current!==input.expected || input.archived!==input.expected) throw new Error('Exact stopped and backed-up component input confirmation required');
}

/** Hash one bounded regular member, but authenticate/drain the complete archive. */
export async function archivedInputDigest(snapshot:string,generation:number,key:Buffer,member:string) {
  let count=0,size=0,invalid=false;
  const hash=createHash('sha256');
  const parser=new Parser({strict:true,onReadEntry(entry){
    if(entry.path!==member){entry.resume();return;}
    count++;
    if(entry.type!=='File' || entry.size>1048576 || count!==1){invalid=true;entry.resume();return;}
    entry.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576)invalid=true;else hash.update(chunk);});
  }});
  await decryptBackupStream(snapshot,generation,key,parser as unknown as Writable);
  if(invalid || count!==1) throw new Error('Exact persistent input missing from authenticated recovery archive');
  return hash.digest('hex');
}

export async function migratePersistentComponentInput(input:{componentId:string;release:string;plan:boolean;expectedDigest?:string|undefined;backupGeneration?:number|undefined;confirm?:boolean|undefined}) {
  if(process.getuid?.()!==0) throw new Error('Component input custody requires the supervisor');
  const host=loadHostConfiguration(),component=installedComponentRelease(input.componentId,input.release);
  if(!host.components[input.componentId]?.enabled || !usesSealedComponentCredentials(host,input.componentId,[]))
    throw new Error('Enabled sealed component binding required');
  const path=`/etc/treeseed/components/${input.componentId}/environment`;
  if(realpathSync(path)!==path) throw new Error('Unsafe persistent component input path');
  const fd=openSync(path,(input.plan?constants.O_RDONLY:constants.O_RDWR)|constants.O_NOFOLLOW);
  const digest=()=>{
    const size=fstatSync(fd).size;if(size>1048576)throw new Error('Input exceeds migration bound');
    const value=Buffer.alloc(size);
    try{if(readSync(fd,value,0,size,0)!==size)throw new Error('Input changed while reading');return createHash('sha256').update(value).digest('hex');}
    finally{value.fill(0);}
  };
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.uid!==0 || stat.nlink!==1 || (stat.mode&0o027) || stat.size>1048576)
      throw new Error('Unsafe persistent component input');
    const current=digest();
    if(input.plan) return {componentId:input.componentId,release:input.release,bytes:stat.size,digest:current,action:stat.size?'migrate':'noop'};
    if(!input.confirm || !input.backupGeneration || !input.expectedDigest) throw new Error('Explicit input migration plan and backup required');
    if(!stat.size) return {componentId:input.componentId,action:'noop'};
    return await withApplicationBackupKey(key=>withVerifiedGenerationBackup(input.backupGeneration!,{backupRoot:paths.backups,key},async (backup,snapshot)=>{
      if((backup.configuration as {configurationId?:string}).configurationId!==host.configurationId)
        throw new Error('Recovery archive belongs to another configuration');
      const archived=await archivedInputDigest(snapshot,input.backupGeneration!,key,path.slice(1));
      const running=(await postgresDocker(['ps','--quiet','--filter',`label=com.docker.compose.project=${component.runtime.compose.projectName}`],15,true)).trim().length>0;
      const observed=lstatSync(path),after=fstatSync(fd);
      if(observed.ino!==stat.ino || observed.dev!==stat.dev || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.nlink!==1)
        throw new Error('Persistent component input changed during migration');
      assertInputMigrationProof({confirmed:input.confirm===true,current:digest(),expected:input.expectedDigest!,archived,running});
      ftruncateSync(fd,0);fsyncSync(fd);
      return {componentId:input.componentId,action:'migrated',backupGeneration:input.backupGeneration};
    }));
  } finally {closeSync(fd);}
}
