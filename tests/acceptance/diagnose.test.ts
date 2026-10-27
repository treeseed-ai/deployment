import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DiagnosticCommands } from '../../src/diagnose.js';
import { PlatformSchemas, type DiagnosticReport } from '@treeseed-cordis/sdk';
import {MissingCompose,ArmSystem,DeploymentTests} from '../support/diagnose-test-support.js';
class DeploymentTestsAcceptance extends DeploymentTests {

  async smoke():Promise<void> {
    const result=spawnSync('node',['--input-type=module','-e',"import {ComposeDeploymentHost} from './dist/src/diagnose.js'; class Probe {static async run(){const report=await new ComposeDeploymentHost().diagnose({port:49191}); if(!Array.isArray(report.checks))process.exit(1);}} await Probe.run();"],{encoding:'utf8'});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
  }
}
const suite=new DeploymentTestsAcceptance();
test("acceptance: built Deployment package runs under Node",suite.smoke.bind(suite));

process.on('exit',suite.cleanup.bind(suite));
