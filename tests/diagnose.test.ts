import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DiagnosticCommands } from '../src/diagnose.js';
import { PlatformSchemas, type DiagnosticReport } from '@treeseed-cordis/sdk';

class MissingCompose implements DiagnosticCommands {
  readonly real=new DockerCommands();
  execute(args:string[]):string|null { if(args.includes('compose'))return null; return this.real.execute(args); }
}
class ArmSystem extends HostSystem {
  override host():DiagnosticReport['host'] { return {...super.host(),architecture:'arm64'}; }
}
class DeploymentTests {
  readonly root=mkdtempSync(join(tmpdir(),'cordis-doctor-'));
  readonly destination=join(this.root,'uncreated');
  server:Server|null=null;
  resolveListen:((port:number)=>void)|null=null;
  async smoke():Promise<void> {
    const result=spawnSync('node',['--input-type=module','-e',"import {ComposeDeploymentHost} from './dist/src/diagnose.js'; class Probe {static async run(){const report=await new ComposeDeploymentHost().diagnose({port:49191}); if(!Array.isArray(report.checks))process.exit(1);}} await Probe.run();"],{encoding:'utf8'});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
  }
  async defaultHost():Promise<void> {
    const before=spawnSync('docker',['ps','-aq'],{encoding:'utf8'}).stdout;
    const report=await new ComposeDeploymentHost().diagnose({installationDirectory:this.destination,port:await this.freePort()});
    expect(PlatformSchemas.diagnostic.safeParse(report).success).toBe(true);
    expect(report.host.os).toBe(process.platform);expect(report.host.architecture).toBe(process.arch);
    expect(report.engine.context).not.toBeNull();
    expect(report.engine.serverVersion).not.toBeNull();expect(report.engine.composeVersion).not.toBeNull();
    expect(report.installation.exists).toBe(false);expect(readdirSync(this.root)).toEqual([]);
    const after=spawnSync('docker',['ps','-aq'],{encoding:'utf8'}).stdout;expect(after).toBe(before);
    if(report.host.distribution==='ubuntu'&&report.host.release==='26.04'&&process.arch==='x64')expect(report.ready).toBe(true);
    else expect(DeploymentTests.codes(report)).toContain('UNSUPPORTED_HOST');
  }
  async remoteContext():Promise<void> {
    const config=join(this.root,'docker-config');mkdirSync(config);
    const made=spawnSync('docker',['--config',config,'context','create','cordis-test-remote','--docker','host=ssh://unused.invalid'],{encoding:'utf8'});
    expect(made.status).toBe(0);
    const prior=process.env.DOCKER_CONFIG;process.env.DOCKER_CONFIG=config;
    try {
      const report=await new ComposeDeploymentHost().diagnose({context:'cordis-test-remote',installationDirectory:this.destination,port:await this.freePort()});
      expect(DeploymentTests.codes(report)).toContain('REMOTE_ENGINE');expect(report.engine.serverVersion).toBeNull();expect(report.engine.endpoint).toBeNull();
    } finally {if(prior===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=prior;rmSync(config,{recursive:true,force:true});}
  }
  async foreignStorage():Promise<void> {
    const foreign=join(this.root,'foreign');mkdirSync(foreign);writeFileSync(join(foreign,'credentials'),'secret-canary');
    const report=await new ComposeDeploymentHost().diagnose({installationDirectory:foreign,port:await this.freePort()});
    expect(DeploymentTests.codes(report)).toContain('FOREIGN_INSTALLATION');expect(JSON.stringify(report)).not.toContain('secret-canary');
    chmodSync(foreign,0o500);
    const denied=await new ComposeDeploymentHost().diagnose({installationDirectory:join(foreign,'new'),port:await this.freePort()});
    expect(DeploymentTests.codes(denied)).toContain('STORAGE_PERMISSION');
    chmodSync(foreign,0o700);rmSync(foreign,{recursive:true});
    const link=join(this.root,'link');symlinkSync(this.root,link);
    const linked=await new ComposeDeploymentHost().diagnose({installationDirectory:join(link,'child'),port:await this.freePort()});
    expect(DeploymentTests.codes(linked)).toContain('STORAGE_SYMLINK');rmSync(link);
  }
  async occupied():Promise<void> {
    const port=await new Promise<number>(this.listen.bind(this));
    try {expect(await new LoopbackProbe().available(port)).toBe(false);}
    finally {this.server!.close();}
  }
  listen(resolve:(port:number)=>void):void {this.resolveListen=resolve;this.server=createServer();this.server.listen(0,'127.0.0.1',this.listening.bind(this));}
  listening():void {const address=this.server!.address();if(address&&typeof address==='object')this.resolveListen!(address.port);}
  async freePort():Promise<number> {const port=await new Promise<number>(this.listen.bind(this));this.server!.close();return port;}
  async missing():Promise<void> {
    const oldPath=process.env.PATH;process.env.PATH='';
    try {const report=await new ComposeDeploymentHost().diagnose({installationDirectory:this.destination,port:await this.freePort()});expect(DeploymentTests.codes(report)).toContain('DOCKER_UNAVAILABLE');}
    finally {process.env.PATH=oldPath;}
    const compose=await new ComposeDeploymentHost(new MissingCompose()).diagnose({installationDirectory:this.destination,port:await this.freePort()});
    expect(DeploymentTests.codes(compose)).toContain('COMPOSE_UNAVAILABLE');
    const arm=await new ComposeDeploymentHost(new DockerCommands(),new ArmSystem()).diagnose({installationDirectory:this.destination,port:await this.freePort()});expect(DeploymentTests.codes(arm)).toContain('UNSUPPORTED_HOST');
  }
  static codes(report:DiagnosticReport):string[] {const codes=[];for(const check of report.checks)if(check.status==='blocked')codes.push(check.code);return codes;}
  cleanup():void {rmSync(this.root,{recursive:true,force:true});}
}
const suite=new DeploymentTests();
test('smoke: built Deployment package runs under Node',suite.smoke.bind(suite));
test('integration: default real diagnostics preserve filesystem and containers',suite.defaultHost.bind(suite));
test('integration: actual remote Docker context is rejected before contact',suite.remoteContext.bind(suite));
test('integration: foreign, denied and symlinked paths remain unchanged',suite.foreignStorage.bind(suite));
test('unit: occupied loopback port is blocked',suite.occupied.bind(suite));
test('unit: missing engine, Compose and unsupported architecture',suite.missing.bind(suite));
process.on('exit',suite.cleanup.bind(suite));
