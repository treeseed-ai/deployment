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
class ProjectionTestsAcceptance extends ProjectionTests {

 async program():Promise<void>{const {fixture,consumer,projection,graph,source}=await this.setup();try{const file=join(fixture.root,'projection-input.json');writeFileSync(file,JSON.stringify({consumer,projection,graph,configuration:fixture.configuration}));const code="import {readFileSync} from 'node:fs';import {ServiceProjection} from '@treeseed-cordis/deployment';class Program{static run(){const input=JSON.parse(readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(ServiceProjection.resolve(input.consumer,input.projection,input.graph,input.configuration))+'\\n');}}Program.run();",result=spawnSync('node',['--input-type=module','-e',code,file],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');const actual=JSON.parse(result.stdout);expect(actual.definition.environment).toEqual({DATABASE:source.serviceId+':8080',INSTANCE:consumer.serviceId,PREFIX:'selected'});expect(actual.resources.grants).toEqual([{serviceId:source.serviceId,slot:'password'}]);expect(existsSync(fixture.installation)).toBe(false);expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);}finally{fixture.close();}}
}
const suite=new ProjectionTestsAcceptance();
test("acceptance: public Node projection resolves owner declarations and scoped references without source imports or effects",suite.program.bind(suite));
