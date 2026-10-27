import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DiagnosticCommands } from '../../src/diagnose.js';
import { PlatformSchemas, type DiagnosticReport } from '@treeseed-cordis/sdk';

export class MissingCompose implements DiagnosticCommands {
  readonly real=new DockerCommands();
  execute(args:string[]):string|null { if(args.includes('compose'))return null; return this.real.execute(args); }
}
export class ArmSystem extends HostSystem {
  override host():DiagnosticReport['host'] { return {...super.host(),architecture:'arm64'}; }
}
export class DeploymentTests {
  readonly root=mkdtempSync(join(tmpdir(),'cordis-doctor-'));
  readonly destination=join(this.root,'uncreated');
  server:Server|null=null;
  resolveListen:((port:number)=>void)|null=null;
  listen(resolve:(port:number)=>void):void {this.resolveListen=resolve;this.server=createServer();this.server.listen(0,'127.0.0.1',this.listening.bind(this));}
  listening():void {const address=this.server!.address();if(address&&typeof address==='object')this.resolveListen!(address.port);}
  async freePort():Promise<number> {const port=await new Promise<number>(this.listen.bind(this));this.server!.close();return port;}
  static codes(report:DiagnosticReport):string[] {const codes=[];for(const check of report.checks)if(check.status==='blocked')codes.push(check.code);return codes;}
  cleanup():void {rmSync(this.root,{recursive:true,force:true});}
}

