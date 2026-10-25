import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceRuntimeFixture} from './service-runtime-fixture.js';
class HostTests {
 async program():Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running();const input=join(fixture.root,'host-input.json');writeFileSync(input,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-host-program.js',input],{encoding:'utf8',timeout:180000});if(result.status!==0)throw new Error(result.stderr);const report=JSON.parse(result.stdout);expect(report.fixtureOnly).toBe(true);expect(report.ready).toBe(true);expect(report.observerRefused).toBe(true);expect(report.closed).toBe(true);expect(report.applicationId).toMatch(/^app-[a-f0-9]{64}$/);}finally{fixture.close();}}
}
const suite=new HostTests();test('smoke: native private host separates observer and owner RPC with durable readback and identity-safe close',suite.program.bind(suite),240000);
