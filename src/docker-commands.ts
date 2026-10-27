import {spawnSync} from 'node:child_process';
import {statSync,accessSync,constants} from 'node:fs';
import {resolve} from 'node:path';
import type {DiagnosticCommands} from './diagnose.js';
export class DockerCommands implements DiagnosticCommands {
  execute(args:string[]):string|null {
    const executable=this.executable();if(!executable)return null;
    const result=spawnSync(executable,args,{env:{...process.env},encoding:'utf8',timeout:5000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
    if(result.error||result.status!==0)return null;
    return result.stdout.trim();
  }
  private executable():string|null {
    for(const directory of (process.env.PATH??'').split(':')) {
      if(!directory)continue;const file=resolve(directory,'docker');
      try{if(statSync(file).isFile()){accessSync(file,constants.X_OK);return file;}}catch{}
    }
    return null;
  }
}
