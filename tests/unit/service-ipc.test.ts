import {test,expect} from 'bun:test';
import {createServer,type Server,Socket} from 'node:net';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceSchemas,CanonicalJson,PlanningBlockedError} from '@treeseed-cordis/sdk';
import {ServiceWorkerClient} from '../../src/diagnose.js';
import {ObserverFixture,ServiceObserverTests} from '../support/service-ipc-test-support.js';
class ServiceObserverTestsUnit extends ServiceObserverTests {

 pathsInvalid():void{for(const socket of ['relative/host.sock','/tmp/../host.sock','/tmp/worker.sock'])expect(ServiceObserverTests.construct.bind(null,socket)).toThrow();}
}
const suite=new ServiceObserverTestsUnit();
test('unit: observer rejects control or ambiguous socket paths',suite.pathsInvalid.bind(suite));
