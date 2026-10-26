import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceRuntimeFixture} from './service-runtime-fixture.js';
class RestartTests {
    async program():Promise<void>{const fixture=new ServiceRuntimeFixture();try{await fixture.running(false,true);const file=join(fixture.root,'restart-input.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-restart-program.js',file],{encoding:'utf8',timeout:240000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,replaced:2,retainedServices:4,unchangedPrivateState:true,sourceFree:true});expect(result.stderr).toBe('');}finally{fixture.close();}}
}
const restart=new RestartTests();
test('smoke: compiled durable host replaces only explicitly scoped container and retains private state and unrelated resources',restart.program.bind(restart),300000);
