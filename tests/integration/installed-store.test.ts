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

 async journal():Promise<void>{const {fixture,plan}=await this.fixture();try{const store=new InstallationStore(fixture.installation);expect(store.publish(plan)).toEqual(plan);expect(store.publish(plan)).toEqual(plan);expect(statSync(join(fixture.installation,'.cordis')).mode&0o777).toBe(0o700);expect(statSync(join(fixture.installation,'.cordis/plans',plan.id+'.json')).mode&0o777).toBe(0o600);const writer=store.writer();try{expect(store.writer.bind(store)).toThrow();const request={protocol:2 as const,operation:'submit' as const,planId:plan.id,digest:plan.digest,idempotencyKey:'one'};const accepted=store.accept(request,writer);expect(accepted.fresh).toBe(true);expect(store.accept(request,writer)).toEqual({record:accepted.record,fresh:false});expect(store.accept.bind(store,{...request,idempotencyKey:'two'},writer)).toThrow();const changed=structuredClone(plan);changed.configuration.runtimeState='stopped';changed.configurationDigest=CanonicalJson.digest(changed.configuration);const {id:_,digest:__,...payload}=changed;changed.digest=CanonicalJson.digest(payload);changed.id='plan-'+changed.digest;store.publish(changed);expect(store.accept.bind(store,{...request,planId:changed.id,digest:changed.digest},writer)).toThrow();}finally{writer.close();}expect(store.records()).toHaveLength(1);expect(new PlanStore(fixture.installation).inspect.bind(new PlanStore(fixture.installation))).toThrow();}finally{fixture.close();}}

 async malformedPlan():Promise<void>{const {fixture,plan}=await this.fixture();try{const store=new InstallationStore(fixture.installation);store.publish(plan);writeFileSync(join(fixture.installation,'.cordis/plans',plan.id+'.json'),'{}',{mode:0o600});expect(store.read.bind(store,plan.id,plan.digest)).toThrow(PlanningBlockedError);}finally{fixture.close();}}

 async interrupted():Promise<void>{const {fixture,plan}=await this.fixture();try{const store=new InstallationStore(fixture.installation);store.publish(plan);writeFileSync(join(fixture.installation,'.cordis/.tmp-uncertain'),'uncertain',{mode:0o600});expect(store.inspect.bind(store)).toThrow();}finally{fixture.close();}}

 async symlink():Promise<void>{const {fixture,plan}=await this.fixture();try{mkdirSync(fixture.installation);symlinkSync(fixture.bundle,join(fixture.installation,'.cordis'));expect(new InstallationStore(fixture.installation).publish.bind(new InstallationStore(fixture.installation),plan)).toThrow();}finally{fixture.close();}}

 async staging():Promise<void>{const {fixture,plan}=await this.fixture();try{new InstallationStore(fixture.installation).publish(plan);const inventory=InstalledSchemas.release.parse({...fixture.inventory,formatVersion:2,composition:plan.composition}),service={...plan.composition.services[0]!,package:'@fixture/plugin',entry:'index.js'},stager=new PreparedProviderStager(plan,inventory),first=await stager.stage(service),second=await stager.stage(service);expect(second).toEqual(first);expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);const manifest=JSON.parse(readFileSync(first.file,'utf8'));expect(manifest.package.name).toBe('@fixture/plugin');expect(statSync(first.file).mode&0o777).toBe(0o400);expect(statSync(first.file.slice(0,first.file.lastIndexOf('/'))).mode&0o777).toBe(0o500);}finally{this.writable(fixture.root);fixture.close();}}
}
const suite=new InstalledTestsIntegration();
test("integration: private journal deterministic publication idempotency and writer fencing",suite.journal.bind(suite));
test("integration: interrupted state requires repair",suite.interrupted.bind(suite));
test("integration: symlink state is never adopted",suite.symlink.bind(suite));
test("integration: isolated archive staging fixture never executes package scripts",suite.staging.bind(suite));
test("integration: malformed installed plan is a typed blocker",suite.malformedPlan.bind(suite));
