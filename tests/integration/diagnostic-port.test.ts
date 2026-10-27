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


  async occupied():Promise<void> {
    const port=await new Promise<number>(this.listen.bind(this));
    try {expect(await new LoopbackProbe().available(port)).toBe(false);}
    finally {this.server!.close();}
  }
}
const suite=new DeploymentTestsIntegration();
test("integration: occupied loopback port is blocked",suite.occupied.bind(suite));
process.on('exit',suite.cleanup.bind(suite));
