import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {ServiceProjectionSchemas,ServiceSchemas,type ServiceInstance,type ServiceGraph} from '@treeseed-cordis/sdk';
import {chmodSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {create} from 'tar';
import {CanonicalJson} from '@treeseed-cordis/sdk';
import {ServiceArtifactResolver} from '../../src/service-artifacts.js';
import {ServiceReleaseFixture,PreparedReleaseFixture} from '../support/release-fixture.js';
import {ProjectionTests} from '../support/service-projection-test-support.js';
class ProjectionTestsUnit extends ProjectionTests {

 async authorityGrant():Promise<void>{const {fixture,graph,source,consumer,projection}=await this.setup();try{const {ServiceProjection}=await import('../../src/service-projection.js');source.resources.authorities=[{id:'public-ca',volume:'data',path:'root.crt'}];source.resources.volumes=['data'];projection.resources.slots={};projection.resources.grants=[{dependencyPort:'storage',slot:'public-ca'}];const result=ServiceProjection.resolve(consumer,projection,graph,fixture.configuration);expect(result.resources.grants).toEqual([{serviceId:source.serviceId,slot:'public-ca'}]);projection.resources.grants[0]!.slot='missing-ca';expect(ServiceProjection.resolve.bind(ServiceProjection,consumer,projection,graph,fixture.configuration)).toThrow();}finally{fixture.close();}}

 async denied():Promise<void>{const {fixture,graph,consumer,projection}=await this.setup();try{const module=await import('../../src/service-projection.js') as unknown as {ServiceProjection:{resolve(service:ServiceInstance,declaration:unknown,graph:ServiceGraph,configuration:unknown):unknown}};projection.resources.grants=[];expect(module.ServiceProjection.resolve.bind(module.ServiceProjection,consumer,projection,graph,fixture.configuration)).toThrow();}finally{fixture.close();}}

 async cycles():Promise<void>{const {fixture,graph,consumer,projection}=await this.setup();try{const module=await import('../../src/service-projection.js') as unknown as {ServiceProjection:{resolve(service:ServiceInstance,declaration:unknown,graph:ServiceGraph,configuration:unknown):unknown}};projection.resources.slots={a:{kind:'text',value:{$secret:{slot:'b'}}},b:{kind:'text',value:{$secret:{slot:'a'}}}};expect(module.ServiceProjection.resolve.bind(module.ServiceProjection,consumer,projection,graph,fixture.configuration)).toThrow();}finally{fixture.close();}}
}
const suite=new ProjectionTestsUnit();
test('unit: a selected dependency does not itself grant its credential',suite.denied.bind(suite));
test('unit: own private template cycles fail before persistence',suite.cycles.bind(suite));
test('unit: declared public authority grants project through the selected typed dependency only',suite.authorityGrant.bind(suite));
