import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ComposeDeploymentHost,ServiceTransitions,ServicePlanStore} from '@treeseed-cordis/deployment';
import {ServiceReleaseFixture} from '../support/release-fixture.js';
import {ServiceRuntimeFixture} from '../support/service-runtime-fixture.js';
import {RetainedPlanningTests} from '../support/service-retained-plan-test-support.js';
class RetainedPlanningTestsAcceptance extends RetainedPlanningTests {
protected async run(apply:boolean):Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running(false,true);const file=join(fixture.root,'retained-plan.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/support/service-retained-plan-program.js',file,apply?'apply':'plan'],{encoding:'utf8',timeout:240000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,retained:5,planned:1,active:apply?6:5,unchanged:true,deterministic:true});expect(result.stderr).toBe('');}finally{fixture.close();}}

    async program():Promise<void>{await this.run(false);}

    async applied():Promise<void>{await this.run(true);}
}
const retainedPlanning=new RetainedPlanningTestsAcceptance();
test("acceptance: default host plans a private addition through the running owner without changing accepted resources credentials or TLS",retainedPlanning.program.bind(retainedPlanning),300000);
test("acceptance: compiled durable default host applies a private addition and retains old resources credentials TLS and request identities",retainedPlanning.applied.bind(retainedPlanning),300000);
