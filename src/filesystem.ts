import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, type Stats } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, visit, type ParseError } from 'jsonc-parser';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';

export class PlanningFailure {
  static block(code:string):never {throw new PlanningBlockedError([{code,message:'Planning validation failed: '+code+'. No activation was performed.'}]);}
  static require(condition:unknown,code:string):asserts condition {if(!condition)this.block(code);}
}
class JsonKeys {
  readonly stack:Set<string>[]=[];
  duplicate=false;
  object():void {this.stack.push(new Set());}
  property(name:string):void {const keys=this.stack[this.stack.length-1]!;if(keys.has(name))this.duplicate=true;keys.add(name);}
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
  childPath(name:string):string {PlanningFailure.require(SafeDirectory.segment(name),'UNSAFE_RELATIVE_PATH');return `/proc/self/fd/${this.fd}/${name}`;}
  directory(path:string,privateMode=false):SafeDirectory {
    let fd=openSync(`/proc/self/fd/${this.fd}`,constants.O_RDONLY|constants.O_DIRECTORY);let current=this.path;const identities=[...this.identities];
    try {
      for(const part of SafeDirectory.relative(path)) {
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
  hash(path:string,expected:string,size?:number):void {
    const parts=SafeDirectory.relative(path),name=parts.pop()!;let directory:SafeDirectory=this;
    try {
      if(parts.length)directory=this.directory(parts.join('/'));
      const fd=openSync(directory.childPath(name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const before=fstatSync(fd);SafeDirectory.owner(before,false);PlanningFailure.require(before.isFile()&&before.nlink===1&&(size===undefined||size===before.size),'OCI_SIZE');
        const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0,count=0;
        while((count=readSync(fd,buffer,0,buffer.length,position))>0){position+=count;hash.update(buffer.subarray(0,count));}
        const after=fstatSync(fd),linked=lstatSync(directory.childPath(name));
        PlanningFailure.require(position===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs&&linked.ino===before.ino&&linked.dev===before.dev,'FILE_CHANGED');
        PlanningFailure.require(hash.digest('hex')===expected,'ARTIFACT_INTEGRITY');directory.verify();
      }finally{closeSync(fd);}
    }catch(error){if(error instanceof PlanningBlockedError)throw error;return PlanningFailure.block('UNSAFE_FILE');}
    finally{if(directory!==this)directory.close();}
  }
  close():void {if(!this.closed){closeSync(this.fd);this.closed=true;}}
}
