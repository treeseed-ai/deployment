import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ComposeDeploymentHost,ServiceTransitions,ServicePlanStore} from '@treeseed-cordis/deployment';
import {ServiceReleaseFixture} from './release-fixture.js';
import {ServiceRuntimeFixture} from './service-runtime-fixture.js';
export class RetainedPlanningTests {
    protected static retained(value:{kind:string}):boolean{return value.kind==='retain';}
    protected static retire(value:{kind:string}):boolean{return value.kind==='retire';}
    protected async run(apply:boolean):Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running(false,true);const file=join(fixture.root,'retained-plan.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/support/service-retained-plan-program.js',file,apply?'apply':'plan'],{encoding:'utf8',timeout:240000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,retained:5,planned:1,active:apply?6:5,unchanged:true,deterministic:true});expect(result.stderr).toBe('');}finally{fixture.close();}}
}
