import type { DiagnosticReport } from '@treeseed-cordis/sdk';
import type { DiagnosticSystem, DiagnosticPorts, StorageResult } from './diagnose.js';
import { readFileSync, lstatSync, readdirSync, accessSync, statfsSync, constants } from 'node:fs';
import { platform, arch } from 'node:os';
import { join, parse, dirname } from 'node:path';
import { ServicePlanStore } from './service-plan.js';
import { InstallationStore } from './installed.js';
import { PlanStore } from './filesystem.js';
export class HostSystem implements DiagnosticSystem {
  host():DiagnosticReport['host'] {
    let release='unknown',distribution='unknown';
    try {
      const text=readFileSync('/etc/os-release','utf8');
      distribution=/^ID=["']?([^\n"']+)/m.exec(text)?.[1]??'unknown';
      release=/^VERSION_ID=["']?([^\n"']+)/m.exec(text)?.[1]??'unknown';
    } catch {}
    return {os:platform(),architecture:arch(),distribution,release};
  }
  storage(path:string):StorageResult {
    let exists=false;
    try {
      let current=parse(path).root, missing=false;
      for(const component of path.slice(current.length).split('/')) {
        if(!component)continue;current=join(current,component);
        try {const stat=lstatSync(current);if(stat.isSymbolicLink())return {exists,freeBytes:null,code:'STORAGE_SYMLINK',message:'Installation path must not traverse symlinks.'};if(!stat.isDirectory())return {exists,freeBytes:null,code:'FOREIGN_INSTALLATION',message:'Installation path must contain only directories.'};}
        catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT'){missing=true;break;}throw error;}
      }
      exists=!missing;
      if(exists&&readdirSync(path).length){try{if(ServicePlanStore.isFormat(path))new ServicePlanStore(path).inspect();else if(new InstallationStore(path).inspect()==='installed')new InstallationStore(path).records();else new PlanStore(path).inspect();}catch{return {exists,freeBytes:null,code:'FOREIGN_INSTALLATION',message:'Existing directory does not contain valid owned plan-only state.'};}}
      let ancestor=path;
      while(true) {try{lstatSync(ancestor);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
      const stat=lstatSync(ancestor);
      if(stat.uid!==process.getuid?.()||(stat.mode&0o300)!==0o300)return {exists,freeBytes:null,code:'STORAGE_PERMISSION',message:'Nearest existing directory must be owned, writable and searchable by this user.'};
      accessSync(ancestor,constants.W_OK|constants.X_OK);
      const space=statfsSync(ancestor),freeBytes=space.bavail*space.bsize;
      return {exists,freeBytes,code:freeBytes>=1024**3?'OK':'STORAGE_CAPACITY',message:freeBytes>=1024**3?'Owned storage has at least 1 GiB free.':'At least 1 GiB free storage is required.'};
    }catch {return {exists,freeBytes:null,code:'STORAGE_PERMISSION',message:'Storage permissions or filesystem information are unavailable.'};}
  }
}
/** Planning only observes Linux listener tables; it never binds a socket. */
export class TcpTableProbe implements DiagnosticPorts {
  async available(port:number):Promise<boolean> {
    try {for(const path of ['/proc/net/tcp','/proc/net/tcp6'])for(const line of readFileSync(path,'utf8').trim().split('\n').slice(1)){const fields=line.trim().split(/\s+/);if(fields[3]==='0A'&&parseInt(fields[1]!.split(':')[1]!,16)===port)return false;}return true;}catch{return false;}
  }
}
