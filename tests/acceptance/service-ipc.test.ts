import {test,expect} from 'bun:test';
import {createServer,type Server,Socket} from 'node:net';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceSchemas,CanonicalJson,PlanningBlockedError} from '@treeseed-cordis/sdk';
import {ServiceWorkerClient} from '../../src/diagnose.js';
import {ObserverFixture,ServiceObserverTests} from '../support/service-ipc-test-support.js';
class ServiceObserverTestsAcceptance extends ServiceObserverTests {

 async program():Promise<void>{const fixture=new ObserverFixture();await fixture.start();try{const child=Bun.spawn(['node','dist/tests/support/service-ipc-program.js',fixture.root],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(0);expect(await new Response(child.stderr).text()).toBe('');expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ready:true,formatVersion:3,services:0});expect(fixture.operations).toEqual(['status']);const client=new ServiceWorkerClient({socket:fixture.path});expect((await client.application('app-'+'c'.repeat(64))).result).toBe('ready');expect(Reflect.has(client,'submit')).toBe(false);expect(Reflect.has(client,'plan')).toBe(false);expect(Reflect.has(client,'install')).toBe(false);}finally{await fixture.close();}}
}
const suite=new ServiceObserverTestsAcceptance();
test("acceptance: built public observer client reads genuine private Unix protocol",suite.program.bind(suite),20000);
