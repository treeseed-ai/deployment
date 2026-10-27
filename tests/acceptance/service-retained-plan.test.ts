import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ComposeDeploymentHost,ServiceTransitions,ServicePlanStore} from '@treeseed-cordis/deployment';
import {ServiceReleaseFixture} from '../support/release-fixture.js';
import {ServiceRuntimeFixture} from '../support/service-runtime-fixture.js';
import {RetainedPlanningTests} from '../support/service-retained-plan-test-support.js';
class RetainedPlanningTestsAcceptance extends RetainedPlanningTests {

    async program():Promise<void>{await this.run(false);}

    async applied():Promise<void>{await this.run(true);}
}
const retainedPlanning=new RetainedPlanningTestsAcceptance();
test("acceptance: default host plans a private addition through the running owner without changing accepted resources credentials or TLS",retainedPlanning.program.bind(retainedPlanning),300000);
test("acceptance: compiled durable default host applies a private addition and retains old resources credentials TLS and request identities",retainedPlanning.applied.bind(retainedPlanning),300000);
