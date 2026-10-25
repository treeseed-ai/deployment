import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceRuntimeFixture} from './service-runtime-fixture.js';
import {ServiceReleaseFixture} from './release-fixture.js';
class ApplicationTests {
 private program(fixture:ServiceReleaseFixture):Record<string,any>{const file=join(fixture.root,'application-input.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-application-program.js',file],{encoding:'utf8',timeout:180000});if(result.status!==0)throw new Error(result.stderr);return JSON.parse(result.stdout);}
 async running():Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running();const report=this.program(fixture);expect(report.fixtureOnly).toBe(true);expect(report.ready).toBe(true);expect(report.application.phase).toBe('completed');expect(report.application.result).toBe('ready');expect(report.resourceCount).toBe(26);expect(report.status.services).toHaveLength(5);expect(report.downReady).toBe(false);}finally{fixture.close();}}
 async stopped():Promise<void>{const fixture=new ServiceReleaseFixture();try{await fixture.services();fixture.configuration.runtimeState='stopped';const report=this.program(fixture);expect(report.fixtureOnly).toBe(true);expect(report.ready).toBe(false);expect(report.application.result).toBe('stopped');expect(report.resourceCount).toBe(0);}finally{fixture.close();}}
}
const suite=new ApplicationTests();test('smoke: built default application root durably commits five native protocol-qualified services and reports subsequent failure',suite.running.bind(suite),240000);test('smoke: built default application root preserves a stopped non-serving composition',suite.stopped.bind(suite),120000);
