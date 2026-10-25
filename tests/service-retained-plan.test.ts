import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ComposeDeploymentHost,ServiceTransitions} from '@treeseed-cordis/deployment';
import {ServiceReleaseFixture} from './release-fixture.js';
import {ServiceRuntimeFixture} from './service-runtime-fixture.js';
class RetainedPlanningTests {
    async classification():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{const first=await new ComposeDeploymentHost().plan(fixture.configuration);if(first.formatVersion!==3)throw new Error('Wrong fixture plan');const probe=structuredClone(first);probe.composition.services[0]!.readiness.deadlineMs--;const changes=ServiceTransitions.plan(first,probe);expect(changes[0]!.kind).toBe('reconfigure');expect(changes[0]!.requiredActions).toEqual(['restart']);const state=structuredClone(first);state.composition.services[0]!.transitionPolicy.stateVersion++;expect(ServiceTransitions.plan(first,state)[0]!.requiredActions).toEqual(['migration']);const removed=structuredClone(first);removed.composition.services.shift();removed.composition.profile.requiredBindings.shift();const retirement=ServiceTransitions.plan(first,removed).find(RetainedPlanningTests.retire);expect(retirement?.requiredActions).toEqual(['removal-unsupported']);const foreign=structuredClone(first);foreign.configuration.installationId='foreign';expect(ServiceTransitions.plan.bind(ServiceTransitions,first,foreign)).toThrow();}finally{fixture.close();}}
    private static retire(value:{kind:string}):boolean{return value.kind==='retire';}
    async program():Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running(false,true);const file=join(fixture.root,'retained-plan.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-retained-plan-program.js',file],{encoding:'utf8',timeout:240000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,retained:5,planned:1,active:5,unchanged:true,deterministic:true});expect(result.stderr).toBe('');}finally{fixture.close();}}
}
const retainedPlanning=new RetainedPlanningTests();
test('smoke: default host plans a private addition through the running owner without changing accepted resources credentials or TLS',retainedPlanning.program.bind(retainedPlanning),300000);

test('integration: data-only transition classification conservatively gates synthetic probe state and removal changes',retainedPlanning.classification.bind(retainedPlanning),60000);
