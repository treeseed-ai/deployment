import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import type { Readable } from 'node:stream';
import { archivedInputDigest,assertInputMigrationProof } from '../src/supervisor/component-input-migration.js';
import { encryptBackupStream } from '../src/supervisor/backup-stream.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

it('requires exact current and archived bytes, stopped services and explicit confirmation',()=>{
  const input={confirmed:true,current:'a'.repeat(64),expected:'a'.repeat(64),archived:'a'.repeat(64),running:false};
  expect(()=>assertInputMigrationProof(input)).not.toThrow();
  for(const changed of [{confirmed:false},{running:true},{current:'b'.repeat(64)},{archived:'b'.repeat(64)},{expected:'invalid'}])
    expect(()=>assertInputMigrationProof({...input,...changed})).toThrow('Exact stopped');
});
it('hashes the exact authenticated archive member without exposing its contents',async()=>{
  const root=mkdtempSync(join(tmpdir(),'treeseed-input-migration-')),key=Buffer.alloc(32,7),path=join(root,'backup.enc');
  try {
    const value='PRIVATE_TOKEN=never-export-this\n';writeFileSync(join(root,'environment'),value,{mode:0o600});
    await encryptBackupStream(c({cwd:root,gzip:true},['environment']) as unknown as Readable,path,42,key);
    expect(await archivedInputDigest(path,42,key,'environment')).toBe(createHash('sha256').update(value).digest('hex'));
    await expect(archivedInputDigest(path,42,key,'missing')).rejects.toThrow('missing');
    const bytes=readFileSync(path);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;writeFileSync(path,bytes);bytes.fill(0);
    await expect(archivedInputDigest(path,42,key,'environment')).rejects.toThrow();
  } finally {key.fill(0);rmSync(root,{recursive:true,force:true});}
});
it('does not accept caller paths, commands or credential values',()=>{
  const request={operation:'component.inputs.migrate',componentId:'admin',release:'1.0.0',plan:true};
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for(const extra of [{path:'/arbitrary'},{command:'truncate'},{credential:'private'}])
    expect(supervisorOperationSchema.safeParse({...request,...extra}).success).toBe(false);
  expect(supervisorOperationSchema.safeParse({...request,componentId:'../admin'}).success).toBe(false);
});
