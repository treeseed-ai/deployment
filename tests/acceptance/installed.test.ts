import {test,expect} from 'bun:test';
import {ComposeDeploymentHost} from '../../src/diagnose.js';
import {InstallationStore,PreparedProviderStager} from '../../src/installed.js';
import {PreparedReleaseFixture} from '../support/release-fixture.js';
import {InstalledSchemas,InstalledDeclarations,PlatformSchemas,CanonicalJson,PlanningBlockedError,type InstalledPlan,type DeploymentPlan} from '@treeseed-cordis/sdk';
import {PlanStore} from '../../src/filesystem.js';
import {mkdirSync,readFileSync,statSync,existsSync,symlinkSync,writeFileSync,chmodSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {InstalledTests} from '../support/installed-test-support.js';
class InstalledTestsAcceptance extends InstalledTests {

 workerProgram():void{const result=spawnSync('node',['dist/src/installed.js','--protocol','1'],{encoding:'utf8'});expect(result.status).toBe(2);expect(result.stdout).toBe('');expect(result.stderr).toBe('');}
}
const suite=new InstalledTestsAcceptance();
test("acceptance: worker program rejects unsupported protocol without side effects",suite.workerProgram.bind(suite));
