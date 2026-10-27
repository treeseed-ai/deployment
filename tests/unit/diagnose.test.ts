import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DiagnosticCommands } from '../../src/diagnose.js';
import { PlatformSchemas, type DiagnosticReport } from '@treeseed-cordis/sdk';
import {MissingCompose,ArmSystem,DeploymentTests} from '../support/diagnose-test-support.js';
class DeploymentTestsUnit extends DeploymentTests {

  async missing():Promise<void> {
    const oldPath=process.env.PATH;process.env.PATH='';
    try {const report=await new ComposeDeploymentHost().diagnose({installationDirectory:this.destination,port:await this.freePort()});expect(DeploymentTests.codes(report)).toContain('DOCKER_UNAVAILABLE');}
    finally {process.env.PATH=oldPath;}
    const compose=await new ComposeDeploymentHost(new MissingCompose()).diagnose({installationDirectory:this.destination,port:await this.freePort()});
    expect(DeploymentTests.codes(compose)).toContain('COMPOSE_UNAVAILABLE');
    const arm=await new ComposeDeploymentHost(new DockerCommands(),new ArmSystem()).diagnose({installationDirectory:this.destination,port:await this.freePort()});expect(DeploymentTests.codes(arm)).toContain('UNSUPPORTED_HOST');
  }
}
const suite=new DeploymentTestsUnit();
test('unit: missing engine, Compose and unsupported architecture',suite.missing.bind(suite));

process.on('exit',suite.cleanup.bind(suite));
