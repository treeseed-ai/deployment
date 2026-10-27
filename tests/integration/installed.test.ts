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
class InstalledTestsIntegration extends InstalledTests {

 async migration():Promise<void>{const {fixture,plan}=await this.fixture();try{const {composition:_,...rest}=plan,payload={...rest,formatVersion:1 as const,pluginBindings:[fixture.metadata]};const {id:__,digest:___,...body}=payload,digest=CanonicalJson.digest(body),legacy=PlatformSchemas.plan.parse({...body,digest,id:'plan-'+digest});new PlanStore(fixture.installation).publish(legacy);const receipt=readFileSync(join(fixture.installation,'.cordis/receipt.json'));const original=readFileSync(join(fixture.installation,'.cordis/plans',legacy.id+'.json'));const store=new InstallationStore(fixture.installation);expect(store.inspect()).toBe('legacy');expect(store.publish.bind(store,plan)).toThrow();store.migrate();expect(store.inspect()).toBe('installed');expect(readFileSync(join(fixture.installation,'.cordis/receipt.json')).equals(receipt)).toBe(true);expect(readFileSync(join(fixture.installation,'.cordis/plans',legacy.id+'.json')).equals(original)).toBe(true);expect(store.migrate.bind(store)).toThrow();expect(store.publish(plan)).toEqual(plan);}finally{fixture.close();}}

 defaultHost():void {const host=new ComposeDeploymentHost();for(const method of ['apply','status','application'])expect(typeof Reflect.get(host,method)).toBe('function');}
}
const suite=new InstalledTestsIntegration();
test('integration: real default Deployment host exposes installed lifecycle boundary',suite.defaultHost.bind(suite));
test('integration: explicit migration preserves historical receipt and plan bytes',suite.migration.bind(suite));
