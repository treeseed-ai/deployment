import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, readdirSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PreparedReleaseFixture } from './release-fixture.js';
import { ArtifactResolver } from '../../src/artifacts.js';
import { ComposeDeploymentHost, HostSystem, DockerCommands } from '../../src/diagnose.js';
import { PlanStore, SafeDirectory, StrictJson } from '../../src/filesystem.js';
import { PlatformSchemas, PlanningBlockedError, CanonicalJson, type DeploymentPlan } from '@treeseed-cordis/sdk';
export class ConcurrentWriter {
  readonly child:ChildProcess;
  completion:((code:number)=>void)|null=null;
  constructor(readonly installation:string,readonly planFile:string) {
    const module=JSON.stringify(resolve('dist/src/filesystem.js'));
    const source=`import {PlanStore} from ${module};import{readFileSync}from'node:fs';class Writer{static run(){try{const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));new PlanStore(process.argv[1]).publish(plan);}catch{process.exitCode=3;}}}Writer.run();`;
    this.child=spawn('node',['--input-type=module','-e',source,installation,planFile],{stdio:['ignore','ignore','ignore']});
  }
  wait():Promise<number> {return new Promise(this.start.bind(this));}
  start(completion:(code:number)=>void):void {this.completion=completion;this.child.once('exit',this.exit.bind(this));this.child.once('error',this.error.bind(this));}
  exit(code:number|null):void {this.completion!(code??1);}
  error():void {this.completion!(1);}
}
export class CollisionCommands extends DockerCommands {
  constructor(readonly project:string) {super();}
  override execute(args:string[]):string|null {if(args.includes('ps'))return JSON.stringify({Names:this.project+'-application',Labels:''});return super.execute(args);}
}
export class ArtifactTests {
  qualified():boolean {const host=new HostSystem().host();return host.distribution==='ubuntu'&&host.release==='26.04'&&host.architecture==='x64';}
}
