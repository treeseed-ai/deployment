import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync,writeFileSync,symlinkSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOsCredentialFile } from '../src/security/custody/os-file.js';
test('OS credential input rejects missing, short, world-readable and symlinked keys',()=>{
  const root=mkdtempSync(join(tmpdir(),'treeseed-os-file-')),file=join(root,'key');
  try {
    assert.throws(()=>readOsCredentialFile(file));writeFileSync(file,'short',{mode:0o600});assert.throws(()=>readOsCredentialFile(file));
    writeFileSync(file,'synthetic-os-private-key-material');assert.equal(readOsCredentialFile(file).length,33);
    symlinkSync(file,join(root,'link'));assert.throws(()=>readOsCredentialFile(join(root,'link')));
    chmodSync(file,0o644);assert.throws(()=>readOsCredentialFile(file));
  }finally{rmSync(root,{recursive:true,force:true});}
});
