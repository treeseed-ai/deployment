import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DiagnosticCommands } from '../../src/diagnose.js';
import { PlatformSchemas, type DiagnosticReport } from '@treeseed-cordis/sdk';
import {MissingCompose,ArmSystem,DeploymentTests} from '../support/diagnose-test-support.js';
class DeploymentTestsIntegration extends DeploymentTests {

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
}
const suite=new DeploymentTestsIntegration();
test('integration: default real diagnostics preserve filesystem and containers',suite.defaultHost.bind(suite));
test('integration: actual remote Docker context is rejected before contact',suite.remoteContext.bind(suite));
test('integration: foreign, denied and symlinked paths remain unchanged',suite.foreignStorage.bind(suite));

process.on('exit',suite.cleanup.bind(suite));
