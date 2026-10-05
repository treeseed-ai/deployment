import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CustodyError } from './contracts.js';
import { LocalSecretCustody } from './local.js';

export type CredentialCommand = (args: string[], input: Buffer) => Buffer;
const command: CredentialCommand = (args,input) => execFileSync('/usr/bin/systemd-creds',args,{input,stdio:['pipe','pipe','pipe'],maxBuffer:1024*1024,timeout:15_000});

/** All host and user key sealing goes through the OS credential facility. */
export class OsSecretCustody {
  readonly #store: LocalSecretCustody;
  readonly #sealed: string;
  readonly #marker: string;
  constructor(readonly root: string, readonly user: boolean, readonly execute: CredentialCommand = command) {
    mkdirSync(root,{recursive:true,mode:0o700});
    this.#store = new LocalSecretCustody(root); // validates ownership and path before file access
    this.#sealed = join(root,'custody.cred'); this.#marker = join(root,'locked');
  }
  #key(create: boolean): Buffer {
    try {
      if (!existsSync(this.#sealed)) {
        if (!create) throw new CustodyError('key_unavailable');
        if(readdirSync(this.root).some(name=>name.endsWith('.enc')))throw new CustodyError('key_unavailable');
        const key = randomBytes(32);
        try {
          const sealed = this.execute(['encrypt',...(this.user?['--user']:[]),'--name=treeseed-custody','-','-'],key);
          writeFileSync(this.#sealed,sealed,{flag:'wx',mode:0o600});
        } finally { key.fill(0); }
      }
      const fd=openSync(this.#sealed,constants.O_RDONLY|constants.O_NOFOLLOW);
      let sealed: Buffer;
      try {
        const stat=fstatSync(fd);
        if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.uid!==process.getuid?.()||stat.size>16384) throw new Error();
        sealed=readFileSync(fd);
      } finally {closeSync(fd);}
      const key=this.execute(['decrypt',...(this.user?['--user']:[]),'--refuse-null','--name=treeseed-custody','-','-'],sealed);
      if(key.length!==32){key.fill(0);throw new Error();}
      return key;
    } catch {throw new CustodyError('os_credential_unavailable');}
  }
  get locked(): boolean {return existsSync(this.#marker);}
  get initialized(): boolean {return existsSync(this.#sealed);}
  lock(): void {
    try {writeFileSync(this.#marker,'locked\n',{flag:'wx',mode:0o600});}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CustodyError('lock_failed');}
    this.#store.lock();
  }
  unlock(create = false): void {
    const key=this.#key(create); key.fill(0);
    if(this.locked)unlinkSync(this.#marker);
  }
  run<T>(operation:(store:LocalSecretCustody)=>T, create = false): T {
    if(this.locked)throw new CustodyError('locked');
    const key=this.#key(create);
    try {this.#store.unlock(key);return operation(this.#store);}
    finally {this.#store.lock();key.fill(0);}
  }
}
