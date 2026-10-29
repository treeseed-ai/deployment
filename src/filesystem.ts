import { createReadStream, constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, mkdirSync, fsyncSync, writeFileSync, linkSync, unlinkSync, type Stats } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { parse, visit, type ParseError } from 'jsonc-parser';
import { PlatformSchemas, CanonicalJson, PlanningBlockedError, type DeploymentPlan, type DeploymentConfiguration } from '@treeseed-cordis/sdk';

export class PlanningFailure {
  static block(code:string):never {throw new PlanningBlockedError([{code,message:'Planning validation failed: '+code+'. No activation was performed.'}]);}
  static require(condition:unknown,code:string):asserts condition {if(!condition)this.block(code);}
}
class JsonKeys {
  readonly stack:Set<string>[]=[];
  duplicate=false;
  object():void {this.stack.push(new Set());}
  property(name:string):void {const keys=this.stack[this.stack.length-1]!;if(keys.has(name)||name==='__proto__')this.duplicate=true;keys.add(name);}
  end():void {this.stack.pop();}
}
export class StrictJson {
  static parse(bytes:Uint8Array,comments=false):unknown {
    PlanningFailure.require(bytes.byteLength<=4*1024*1024,'METADATA_TOO_LARGE');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),errors:ParseError[]=[],keys=new JsonKeys();
    visit(text,{onObjectBegin:keys.object.bind(keys),onObjectProperty:keys.property.bind(keys),onObjectEnd:keys.end.bind(keys)},{allowTrailingComma:comments,disallowComments:!comments});
    const result:unknown=parse(text,errors,{allowTrailingComma:comments,disallowComments:!comments});
    PlanningFailure.require(errors.length===0&&!keys.duplicate,'INVALID_JSON');return result;
  }
  static object(value:unknown):Record<string,unknown> {PlanningFailure.require(value!==null&&typeof value==='object'&&!Array.isArray(value),'INVALID_METADATA');return value as Record<string,unknown>;}
}
interface Identity {path:string;dev:number;ino:number;}
/** Linux descriptor-anchored reads; caller-supplied paths never become /proc traversal segments. */
export class SafeDirectory {
  private closed=false;
  private constructor(readonly fd:number,readonly path:string,private readonly identities:Identity[]) {}
  static open(path:string):SafeDirectory {
    PlanningFailure.require(path.startsWith('/')&&!path.includes('\0'),'UNSAFE_PATH');
    const canonical=resolve(path);let fd=-1;
    try {
      fd=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const identities:Identity[]=[];
      let current='/';
      for(const part of canonical.split('/').filter(SafeDirectory.nonempty)) {
        const next=openSync(`/proc/self/fd/${fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);closeSync(fd);fd=next;current=join(current,part);
        const stat=fstatSync(fd);this.owner(stat,false);identities.push({path:current,dev:stat.dev,ino:stat.ino});
      }
      return new SafeDirectory(fd,canonical,identities);
    }catch{if(fd!==-1)closeSync(fd);return PlanningFailure.block('UNSAFE_PATH');}
  }
  static nonempty(value:string):boolean {return value.length>0;}
  static owner(stat:Stats,privateMode:boolean):void {
    const uid=process.getuid?.();PlanningFailure.require(uid!==undefined&&(stat.uid===uid||(!privateMode&&stat.uid===0)),'PATH_OWNER');
    const sharedSticky=stat.isDirectory()&&stat.uid===0&&(stat.mode&0o1000)!==0;
    PlanningFailure.require((stat.mode&0o022)===0||(!privateMode&&sharedSticky),'PATH_PERMISSIONS');
    if(privateMode)PlanningFailure.require((stat.mode&0o777)===(stat.isDirectory()?0o700:0o600),'PRIVATE_PERMISSIONS');
  }
  static relative(path:string):string[] {
    const parts=path.split('/');PlanningFailure.require(parts.length>0&&parts.every(SafeDirectory.segment),'UNSAFE_RELATIVE_PATH');return parts;
  }
  static segment(part:string):boolean {return /^[a-zA-Z0-9_@.-]+$/.test(part)&&part!=='.'&&part!=='..';}
  static component(name:string):boolean {return name.length>0&&name!=='.'&&name!=='..'&&!name.includes('/')&&!name.includes('\0');}
  childPath(name:string):string {PlanningFailure.require(SafeDirectory.component(name),'UNSAFE_RELATIVE_PATH');return `/proc/self/fd/${this.fd}/${name}`;}
  directory(path:string,privateMode=false):SafeDirectory {
    let fd=openSync(`/proc/self/fd/${this.fd}`,constants.O_RDONLY|constants.O_DIRECTORY);let current=this.path;const identities=[...this.identities];
    try {
      const parts=path.split('/');PlanningFailure.require(parts.every(SafeDirectory.component),'UNSAFE_RELATIVE_PATH');
      for(const part of parts) {
        const next=openSync(`/proc/self/fd/${fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);closeSync(fd);fd=next;current=join(current,part);
        const stat=fstatSync(fd);SafeDirectory.owner(stat,privateMode);identities.push({path:current,dev:stat.dev,ino:stat.ino});
      }
      return new SafeDirectory(fd,current,identities);
    }catch{closeSync(fd);return PlanningFailure.block('UNSAFE_PATH');}
  }
  entries():string[] {return readdirSync(`/proc/self/fd/${this.fd}`).sort();}
  verify():void {
    for(const identity of this.identities){const current=lstatSync(identity.path);PlanningFailure.require(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino,'PATH_CHANGED');SafeDirectory.owner(current,false);}
  }
  file(path:string,expected?:string,maximum=64*1024*1024,privateMode=false):Buffer {
    const parts=SafeDirectory.relative(path),name=parts.pop()!;let directory:SafeDirectory=this;
    try {
      if(parts.length)directory=this.directory(parts.join('/'));
      const fd=openSync(directory.childPath(name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const before=fstatSync(fd);PlanningFailure.require(before.isFile()&&before.nlink===1&&before.size<=maximum,'UNSAFE_FILE');SafeDirectory.owner(before,privateMode);
        const bytes=Buffer.alloc(before.size);let position=0;
        while(position<bytes.length){const count=readSync(fd,bytes,position,bytes.length-position,position);PlanningFailure.require(count>0,'FILE_CHANGED');position+=count;}
        const after=fstatSync(fd);PlanningFailure.require(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'FILE_CHANGED');
        const linked=lstatSync(directory.childPath(name));PlanningFailure.require(linked.dev===before.dev&&linked.ino===before.ino&&!linked.isSymbolicLink(),'FILE_CHANGED');
        if(expected)PlanningFailure.require(createHash('sha256').update(bytes).digest('hex')===expected,'ARTIFACT_INTEGRITY');directory.verify();return bytes;
      }finally{closeSync(fd);}
    }catch(error){if(error instanceof PlanningBlockedError)throw error;return PlanningFailure.block('UNSAFE_FILE');}
    finally{if(directory!==this)directory.close();}
  }
  hash(path: string, expected: string, size?: number, privateMode = false): void {
    let file: VerifiedDescriptor | null = null;
    try {
      file = VerifiedDescriptor.open(this, path, privateMode);
      file.hash(expected, size);
    } catch (error) {
      if (error instanceof PlanningBlockedError) throw error;
      return PlanningFailure.block('UNSAFE_FILE');
    } finally {
      file?.close();
    }
  }
  close():void {if(!this.closed){closeSync(this.fd);this.closed=true;}}
}

/** Shared file custody; hashing never changes the anchored pathname or releases its descriptor. */
export class VerifiedDescriptor {
  private closed = false;
  private readonly before: Stats;
  private static readonly identity = [
    'dev',
    'ino',
    'size',
    'mtimeMs',
    'ctimeMs',
    'uid',
    'gid',
    'mode',
    'nlink',
  ] as const;
  private constructor(
    private readonly fd: number,
    private readonly directory: SafeDirectory,
    private readonly name: string,
    private readonly privateMode: boolean,
    private readonly ownsDirectory: boolean,
  ) {
    this.before = fstatSync(fd);
    this.valid(this.before);
    this.verify();
  }
  static open(root: SafeDirectory, path: string, privateMode = false): VerifiedDescriptor {
    const parts = SafeDirectory.relative(path),
      name = parts.pop()!;
    const directory = parts.length ? root.directory(parts.join('/')) : root;
    let fd = -1;
    try {
      fd = openSync(
        directory.childPath(name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      return new VerifiedDescriptor(fd, directory, name, privateMode, directory !== root);
    } catch (error) {
      if (fd !== -1) closeSync(fd);
      if (directory !== root) directory.close();
      throw error;
    }
  }
  private valid(stat: Stats): void {
    SafeDirectory.owner(stat, this.privateMode);
    PlanningFailure.require(stat.isFile() && stat.nlink === 1, 'OCI_SIZE');
  }
  verify(): void {
    PlanningFailure.require(!this.closed, 'FILE_CLOSED');
    this.directory.verify();
    const actual = fstatSync(this.fd),
      linked = lstatSync(this.directory.childPath(this.name));
    for (const key of VerifiedDescriptor.identity)
      PlanningFailure.require(
        actual[key] === this.before[key] && linked[key] === this.before[key],
        'FILE_CHANGED',
      );
    this.valid(actual);
    this.valid(linked);
    PlanningFailure.require(!linked.isSymbolicLink(), 'FILE_CHANGED');
  }
  prefix(size: number): Buffer {
    PlanningFailure.require(Number.isInteger(size) && size > 0 && size <= 4096, 'UNSAFE_FILE');
    this.verify();
    const bytes = Buffer.alloc(size),
      count = readSync(this.fd, bytes, 0, size, 0);
    this.verify();
    return bytes.subarray(0, count);
  }
  private begin(size?: number): Hash {
    this.verify();
    PlanningFailure.require(size === undefined || size === this.before.size, 'OCI_SIZE');
    return createHash('sha256');
  }
  private finish(hash: Hash, expected: string, size: number): void {
    this.verify();
    PlanningFailure.require(size === this.before.size, 'FILE_CHANGED');
    PlanningFailure.require(hash.digest('hex') === expected, 'ARTIFACT_INTEGRITY');
  }
  hash(expected: string, size?: number): void {
    const hash = this.begin(size),
      buffer = Buffer.alloc(1024 * 1024);
    let position = 0,
      count = 0;
    while ((count = readSync(this.fd, buffer, 0, buffer.length, position)) > 0) {
      position += count;
      hash.update(buffer.subarray(0, count));
    }
    this.finish(hash, expected, position);
  }
  async hashAsync(expected: string, size: number, signal: AbortSignal): Promise<void> {
    const hash = this.begin(size);
    PlanningFailure.require(size > 0, 'OCI_SIZE');
    signal.throwIfAborted();
    const stream = this.stream(size, signal);
    let count = 0;
    for await (const chunk of stream) {
      count += chunk.length;
      hash.update(chunk);
    }
    signal.throwIfAborted();
    this.finish(hash, expected, count);
  }
  private stream(size: number, signal: AbortSignal): import('node:fs').ReadStream {
    const fd = openSync('/proc/self/fd/' + this.fd, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return createReadStream('', {
        fd,
        autoClose: true,
        start: 0,
        end: size - 1,
        highWaterMark: 1024 * 1024,
        signal,
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      if (this.ownsDirectory) this.directory.close();
    }
  }
}

/** Accepted plan bytes are the only Task 2 lifecycle records. No active-state transitions. */
export class PlanStore {
  constructor(readonly installationDirectory:string) {}
  private scope(plan:DeploymentPlan):void {
    PlanningFailure.require(plan.configuration.installationDirectory===resolve(this.installationDirectory),'FOREIGN_INSTALLATION');
    const {id,digest,...payload}=plan;PlanningFailure.require(id==='plan-'+digest&&CanonicalJson.digest(payload)===digest,'PLAN_DIGEST');
    PlanningFailure.require(plan.configurationDigest===CanonicalJson.digest(plan.configuration)&&plan.releaseDigest===plan.configuration.release.manifestDigest,'PLAN_BINDING');
    PlanningFailure.require(plan.projectName==='cordis-'+CanonicalJson.digest({installationId:plan.configuration.installationId,installationDirectory:plan.configuration.installationDirectory}).slice(0,16),'PLAN_BINDING');
  }
  private anchor():{directory:SafeDirectory;missing:string[]} {
    const missing:string[]=[];let path=resolve(this.installationDirectory);
    while(true){try{lstatSync(path);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return PlanningFailure.block('STORAGE_PERMISSION');missing.unshift(basename(path));const parent=dirname(path);PlanningFailure.require(parent!==path,'UNSAFE_PATH');path=parent;}}
    const directory=SafeDirectory.open(path),stat=fstatSync(directory.fd);
    try {PlanningFailure.require(stat.uid===process.getuid?.()&&(stat.mode&0o300)===0o300,'STORAGE_PERMISSION');return {directory,missing};}catch(error){directory.close();throw error;}
  }
  inspect(configuration?:DeploymentConfiguration,engine?:DeploymentPlan['expectedEngine']):boolean {
    const anchor=this.anchor();
    try {
      if(anchor.missing.length)return false;const entries=anchor.directory.entries();if(entries.length===0)return false;
      PlanningFailure.require(entries.length===1&&entries[0]==='.cordis','FOREIGN_INSTALLATION');
      const state=anchor.directory.directory('.cordis',true);
      try {
        PlanningFailure.require(state.entries().join(',')==='plans,receipt.json','INVALID_JOURNAL');
        const receipt=StrictJson.object(StrictJson.parse(state.file('receipt.json',undefined,1024*1024,true)));
        PlanningFailure.require(Object.keys(receipt).sort().join(',')==='activeComposition,expectedEngine,formatVersion,installationDirectory,installationId,ownerUid','INVALID_JOURNAL');
        PlanningFailure.require(receipt.formatVersion===1&&receipt.activeComposition===null&&receipt.ownerUid===process.getuid?.()&&receipt.installationDirectory===resolve(this.installationDirectory)&&typeof receipt.installationId==='string','FOREIGN_INSTALLATION');
        const expected=PlatformSchemas.expectedEngine.safeParse(receipt.expectedEngine);PlanningFailure.require(expected.success,'INVALID_JOURNAL');
        if(configuration)PlanningFailure.require(receipt.installationId===configuration.installationId,'FOREIGN_INSTALLATION');
        if(engine)PlanningFailure.require(CanonicalJson.stringify(expected.data)===CanonicalJson.stringify(engine),'ENGINE_IDENTITY_CHANGED');
        const plans=state.directory('plans',true);
        try {
          const names=plans.entries();PlanningFailure.require(names.length>0&&names.length<=10000,'INCOMPLETE_JOURNAL');
          for(const name of names){PlanningFailure.require(/^plan-[a-f0-9]{64}\.json$/.test(name),'INVALID_JOURNAL');const plan=this.parse(plans.file(name,undefined,4*1024*1024,true));this.scope(plan);PlanningFailure.require(name===plan.id+'.json'&&plan.configuration.installationId===receipt.installationId&&CanonicalJson.stringify(plan.expectedEngine)===CanonicalJson.stringify(expected.data),'FOREIGN_INSTALLATION');}
          state.verify();anchor.directory.verify();return true;
        }finally{plans.close();}
      }finally{state.close();}
    }catch(error){if(error instanceof PlanningBlockedError)throw error;return PlanningFailure.block('INVALID_JOURNAL');}finally{anchor.directory.close();}
  }
  read(id:string,digest:string):DeploymentPlan {
    PlanningFailure.require(/^plan-[a-f0-9]{64}$/.test(id)&&id==='plan-'+digest,'PLAN_IDENTITY');this.inspect();
    const installation=SafeDirectory.open(this.installationDirectory);
    try {const plans=installation.directory('.cordis/plans',true);try{const plan=this.parse(plans.file(id+'.json',undefined,4*1024*1024,true));this.scope(plan);PlanningFailure.require(plan.id===id&&plan.digest===digest,'PLAN_IDENTITY');return plan;}finally{plans.close();}}finally{installation.close();}
  }
  publish(plan:DeploymentPlan):DeploymentPlan {
    plan=PlatformSchemas.plan.parse(plan);this.scope(plan);PlanningFailure.require(Buffer.byteLength(CanonicalJson.stringify(plan))<4*1024*1024,'PLAN_TOO_LARGE');const exists=this.inspect(plan.configuration,plan.expectedEngine),anchor=this.anchor();let installation=anchor.directory;
    try {
      for(const part of anchor.missing){const next=this.mkdir(installation,part);if(installation!==anchor.directory)installation.close();installation=next;}
      if(!exists) {
        PlanningFailure.require(installation.entries().length===0,'INITIALIZATION_CONFLICT');
        const state=this.mkdir(installation,'.cordis');
        try{const plans=this.mkdir(state,'plans');plans.close();this.publishFile(state,'receipt.json',CanonicalJson.stringify({formatVersion:1,installationId:plan.configuration.installationId,installationDirectory:plan.configuration.installationDirectory,ownerUid:process.getuid!(),expectedEngine:plan.expectedEngine,activeComposition:null})+'\n');}finally{state.close();}
      }
      const plans=installation.directory('.cordis/plans',true);
      try{installation.verify();this.publishFile(plans,plan.id+'.json',CanonicalJson.stringify(plan)+'\n');plans.verify();}finally{plans.close();}
    }finally{if(installation!==anchor.directory)installation.close();anchor.directory.close();}
    return this.read(plan.id,plan.digest);
  }
  private mkdir(parent:SafeDirectory,name:string):SafeDirectory {mkdirSync(parent.childPath(name),{mode:0o700});fsyncSync(parent.fd);parent.verify();return parent.directory(name,true);}
  private publishFile(directory:SafeDirectory,name:string,bytes:string):void {
    const temporary='.tmp-'+randomUUID(),path=directory.childPath(temporary);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    try {
      directory.verify();
      try{linkSync(path,directory.childPath(name));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;PlanningFailure.require(directory.file(name,undefined,4*1024*1024,true).toString()===bytes,'PLAN_CONFLICT');}
      fsyncSync(directory.fd);
    }finally{unlinkSync(path);}
  }
  private parse(bytes:Buffer):DeploymentPlan {const result=PlatformSchemas.plan.safeParse(StrictJson.parse(bytes));PlanningFailure.require(result.success,'INVALID_PLAN');return result.data;}
}
