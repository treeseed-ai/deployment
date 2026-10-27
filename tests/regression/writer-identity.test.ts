import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceReleaseFixture} from '../support/release-fixture.js';
import {ComposeDeploymentHost,ServicePlanStore} from '../../src/diagnose.js';
class WriterIdentityTests {
 async ownerRecord():Promise<void>{const fixture=await new ServiceReleaseFixture().services();let writer:ReturnType<ServicePlanStore['writer']>|undefined;try{await new ComposeDeploymentHost().plan(fixture.configuration);const store=new ServicePlanStore(fixture.installation);writer=store.writer();const file=join(fixture.installation,'.cordis/writer.lock/owner.json'),bytes=readFileSync(file),owner=JSON.parse(bytes.toString());owner.nonce='00000000-0000-0000-0000-000000000000';writeFileSync(file,JSON.stringify(owner)+'\n');expect(writer.assert.bind(writer,fixture.installation)).toThrow();writeFileSync(file,bytes);expect(writer.assert.bind(writer,fixture.installation)).toThrow();expect(writer.close.bind(writer)).toThrow();expect(existsSync(file)).toBe(true);}finally{try{writer?.close();}catch{}fixture.close();}}
}
const suite=new WriterIdentityTests();test("regression: replaced writer owner records fence authority and preserve uncertain locks",suite.ownerRecord.bind(suite));
