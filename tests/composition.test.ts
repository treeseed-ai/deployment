import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CordisComposition, Context } from '@treeseed-cordis/sdk/runtime';
import { DeploymentComposition, DeploymentCapability } from '../src/composition.js';
class Receiver {context:Context|null=null;}
class DeploymentConsumer {static readonly inject=['deployment'];constructor(context:Context,receiver:Receiver){receiver.context=context;}}
class NativeDeploymentTests {
  async defaultConstruction():Promise<void> {
    const root=mkdtempSync(join(tmpdir(),'native-deployment-'));
    const scope={scopeId:'deployment-test',target:'cli' as const,principalId:'fixture-owner',resourceScope:root};
    const handle=await CordisComposition.start({registrations:DeploymentComposition.registrations({kind:'bundled',identity:'owner-test'}),selections:DeploymentComposition.selections(scope.scopeId)},scope),receiver=new Receiver();
    try {await handle.mount(DeploymentConsumer,receiver);const lease=await handle.locator(receiver.context!).acquire(DeploymentCapability);const report=await lease.value.diagnose({installationDirectory:join(root,'uncreated'),port:49391});expect(report.host.os).toBe(process.platform);expect(report.engine.context).not.toBeNull();expect(readdirSync(root)).toEqual([]);expect(handle.describe(DeploymentCapability).length).toBe(1);await lease.release();}finally{await handle.dispose();rmSync(root,{recursive:true,force:true});}
  }
  async program():Promise<void> {
    const code="import {CordisComposition,Context} from '@treeseed-cordis/sdk/runtime';import{DeploymentComposition}from'./dist/src/composition.js';class Probe{static async run(){const h=await CordisComposition.start({registrations:DeploymentComposition.registrations({kind:'bundled',identity:'program-test'}),selections:DeploymentComposition.selections('program')},{scopeId:'program',target:'cli',principalId:'owner',resourceScope:'fixture'});if(!Context.is(h.context)||h.context.registry.size<4)throw new Error('not native');await h.dispose();}}await Probe.run();";
    const result=spawnSync('node',['--input-type=module','-e',code],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');
  }
}
const suite=new NativeDeploymentTests();
test('integration: default Deployment plugin uses real native I/O and host providers',suite.defaultConstruction.bind(suite));
test('smoke: public Deployment native composition runs under Node',suite.program.bind(suite));
