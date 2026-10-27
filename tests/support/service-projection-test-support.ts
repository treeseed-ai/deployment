import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {ServiceProjectionSchemas,ServiceSchemas,type ServiceInstance,type ServiceGraph} from '@treeseed-cordis/sdk';
import {chmodSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {create} from 'tar';
import {CanonicalJson} from '@treeseed-cordis/sdk';
import {ServiceArtifactResolver} from '../../src/service-artifacts.js';
import {ServiceReleaseFixture,PreparedReleaseFixture} from './release-fixture.js';
export class ProjectionTests {
 protected async setup(){const fixture=await new ServiceReleaseFixture().services(),graph=fixture.release.composition,source=graph.services[0]!;source.resources.slots={password:{kind:'random'}};const consumer=graph.services[4]!;consumer.configuration={prefix:'selected'};consumer.dependencies=[{port:'storage',bindingId:source.bindings[0]!.bindingId,contractId:'fixture.echo',contractVersion:'1.0.0'}];consumer.resources.grants=[{serviceId:source.serviceId,slot:'password'}];const projection=ServiceProjectionSchemas.container.parse({definition:{...consumer.definition,environment:{DATABASE:{$endpoint:{dependencyPort:'storage',portId:'http',scheme:'tcp',path:'/',part:'authority'}},INSTANCE:{$context:'serviceId'},PREFIX:{$configuration:['prefix']}}},resources:{...consumer.resources,grants:[{dependencyPort:'storage',slot:'password'}],slots:{config:{kind:'json',value:{password:{$secret:{dependencyPort:'storage',slot:'password'}},origin:{$context:'origin'}}}}},providedContracts:[{port:'http',contractId:'fixture.echo',contractVersion:'1.0.0'}],dependencies:[{port:'storage',contractId:'fixture.echo',contractVersion:'1.0.0'}],observationContract:'fixture.echo',transitionPolicy:consumer.transitionPolicy});return {fixture,graph,source,consumer,projection};}
}
