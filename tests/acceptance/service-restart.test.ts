import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceRuntimeFixture} from '../support/service-runtime-fixture.js';
class RestartTests {
    async failed():Promise<void>{await this.run(true);}
    async program():Promise<void>{await this.run(false);}
    private async run(failure:boolean):Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running(false,true,['instance-0','instance-2']);const file=join(fixture.root,'restart-input.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/support/service-restart-program.js',file,failure?'failure':'success'],{encoding:'utf8',timeout:240000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual(failure?{fixtureOnly:true,failed:true,priorSnapshotRetained:true,privateBytesRetained:true,repairRequired:true}:{fixtureOnly:true,replaced:2,retainedServices:4,unchangedPrivateState:true,sourceFree:true});expect(result.stderr).toBe('');}finally{fixture.close();}}
}
const restart=new RestartTests();
test("acceptance: compiled durable host replaces only explicitly scoped container and retains private state and unrelated resources",restart.program.bind(restart),300000);

test("acceptance: failed explicit restart preserves prior snapshot and private bytes and fences implicit repair",restart.failed.bind(restart),300000);
class ReplacementFixtureTests {
    node():void{const source="import {PackageDefinition,CanonicalJson} from '@treeseed-cordis/sdk';import {RestartAuthorityFixture,RestartUnreadyProbeFixture,AuthorityContainerFixture} from './dist/tests/service-fixture-plugins.js';class Program{static run(){const container=PackageDefinition.export(RestartAuthorityFixture,'index.js','RestartAuthorityFixture'),probe=PackageDefinition.export(RestartUnreadyProbeFixture,'index.js','RestartUnreadyProbeFixture');if(container.declaration.id!=='fixture.restart-authority'||probe.declaration.id!=='fixture.restart-unready-probe'||CanonicalJson.stringify(container.container.resources)!==CanonicalJson.stringify(AuthorityContainerFixture.container.resources)||container.container.definition.environment.FIXTURE_REVISION!=='replacement'||probe.probe.observationContracts[0]!=='fixture.echo')throw new Error('Native replacement fixture mismatch');process.stdout.write('native-restart-fixtures-ok\\n');}}Program.run();";const result=spawnSync('node',['--input-type=module','-e',source],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.stdout).toBe('native-restart-fixtures-ok\n');}
}
const replacementFixtures=new ReplacementFixtureTests();
test("acceptance: built Node replacement fixture classes project their native typed contracts",replacementFixtures.node.bind(replacementFixtures));
