import { closeSync,constants,existsSync,fsyncSync,fstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { LocalSecretCustody } from '../security/custody/local.js';
import { managedPostgresTransferPlanSchema,managedPostgresTransferSelectionSchema } from './managed-transfer-contract.js';

const recordSchema=z.object({selection:managedPostgresTransferSelectionSchema,plan:managedPostgresTransferPlanSchema}).strict()
  .refine(value=>value.plan.selectionDigest===deploymentDigest(value.selection),'Transfer selection changed');

/** Immutable root-owned plan context for exact replay after the old database is
 * stopped. Keep only descriptors, never SQL, database rows or credentials. The
 * owner serializes this store with the transfer journal's OS lock.
 */
export class PostgresTransferPlanStore {
  constructor(private readonly root:string) {mkdirSync(root,{recursive:true,mode:0o700});new LocalSecretCustody(root);}
  private path(digest:string) {
    if(!/^sha256:[a-f0-9]{64}$/u.test(digest))throw new Error('Exact transfer plan digest required');
    return join(this.root,`${digest.slice(7)}.json`);
  }
  read(digest:string) {
    const path=this.path(digest);let fd:number;
    try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Unsafe transfer plan custody');}
    try {
      const stat=fstatSync(fd);
      if(!stat.isFile() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode&0o077) || stat.size>262144)throw new Error();
      const record=recordSchema.parse(JSON.parse(readFileSync(fd,'utf8')));
      if(record.plan.planDigest!==digest)throw new Error();return record;
    } catch {throw new Error('Invalid transfer plan custody; retain coordinated recovery');}
    finally{closeSync(fd);}
  }
  save(input:unknown) {
    const record=recordSchema.parse(input),digest=record.plan.planDigest,existing=this.read(digest);
    if(existing) {
      if(deploymentDigest(existing)!==deploymentDigest(record))throw new Error('Immutable transfer plan conflict');
      return {action:'noop' as const};
    }
    const temporary=join(this.root,`.plan-${randomUUID()}.new`);
    try {
      const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temporary,this.path(digest));
      const directory=openSync(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{fsyncSync(directory);}finally{closeSync(directory);}
    } finally {if(existsSync(temporary))unlinkSync(temporary);}
    return {action:'recorded' as const};
  }
}
