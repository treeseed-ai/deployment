import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CordisComposition, Context } from '@treeseed-cordis/sdk/runtime';
import { DeploymentComposition, DeploymentCapability } from '../../src/composition.js';
import {Receiver,DeploymentConsumer} from '../support/composition-test-support.js';
class NativeDeploymentTestsIntegration {

  async defaultConstruction():Promise<void> {
    const root=mkdtempSync(join(tmpdir(),'native-deployment-'));
    const scope={scopeId:'deployment-test',target:'cli' as const,principalId:'fixture-owner',resourceScope:root};
    const handle=await CordisComposition.start({registrations:DeploymentComposition.registrations({kind:'bundled',identity:'owner-test'}),selections:DeploymentComposition.selections(scope.scopeId)},scope),receiver=new Receiver();
    try {await handle.mount(DeploymentConsumer,receiver);const lease=await handle.locator(receiver.context!).acquire(DeploymentCapability);const report=await lease.value.diagnose({installationDirectory:join(root,'uncreated'),port:49391});expect(report.host.os).toBe(process.platform);expect(report.engine.context).not.toBeNull();expect(readdirSync(root)).toEqual([]);expect(handle.describe(DeploymentCapability).length).toBe(1);await lease.release();}finally{await handle.dispose();rmSync(root,{recursive:true,force:true});}
  }
}
const suite=new NativeDeploymentTestsIntegration();
test('integration: default Deployment plugin uses real native I/O and host providers',suite.defaultConstruction.bind(suite));
