import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CordisComposition, Context } from '@treeseed-cordis/sdk/runtime';
import { DeploymentComposition, DeploymentCapability } from '../../src/composition.js';
import {Receiver,DeploymentConsumer} from '../support/composition-test-support.js';
class NativeDeploymentTestsAcceptance {

  async program():Promise<void> {
    const code="import {CordisComposition,Context} from '@treeseed-cordis/sdk/runtime';import{DeploymentComposition}from'./dist/src/composition.js';class Probe{static async run(){const h=await CordisComposition.start({registrations:DeploymentComposition.registrations({kind:'bundled',identity:'program-test'}),selections:DeploymentComposition.selections('program')},{scopeId:'program',target:'cli',principalId:'owner',resourceScope:'fixture'});if(!Context.is(h.context)||h.context.registry.size<4)throw new Error('not native');await h.dispose();}}await Probe.run();";
    const result=spawnSync('node',['--input-type=module','-e',code],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');
  }
}
const suite=new NativeDeploymentTestsAcceptance();
test("acceptance: public Deployment native composition runs under Node",suite.program.bind(suite));
