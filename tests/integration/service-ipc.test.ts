import {test,expect} from 'bun:test';
import {createServer,type Server,Socket} from 'node:net';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceSchemas,CanonicalJson,PlanningBlockedError} from '@treeseed-cordis/sdk';
import {ServiceWorkerClient} from '../../src/diagnose.js';
import {ObserverFixture,ServiceObserverTests} from '../support/service-ipc-test-support.js';
class ServiceObserverTestsIntegration extends ServiceObserverTests {

 async failures():Promise<void>{const fixture=new ObserverFixture();await fixture.start();try{for(const mode of ['malformed','duplicate','oversized','wrong-result','runtime','timeout']){fixture.mode=mode;let failure:unknown;try{await new ServiceWorkerClient({socket:fixture.path,timeoutMs:100}).status();}catch(error){failure=error;}expect(failure instanceof Error).toBe(true);expect(String(failure).includes('CANARY_PRIVATE')).toBe(false);expect(failure instanceof PlanningBlockedError).toBe(false);}fixture.mode='blocked';let blocked:unknown;try{await new ServiceWorkerClient({socket:fixture.path}).status();}catch(error){blocked=error;}expect(blocked instanceof PlanningBlockedError).toBe(true);expect((blocked as PlanningBlockedError).blockers[0]!.code).toBe('STALE_GENERATION');expect(JSON.stringify(blocked).includes('CANARY_PRIVATE')).toBe(false);}finally{await fixture.close();}}

 async paths():Promise<void>{const fixture=new ObserverFixture();await fixture.start();try{chmodSync(fixture.path,0o666);await expect(new ServiceWorkerClient({socket:fixture.path}).status()).rejects.toThrow();chmodSync(fixture.path,0o600);fixture.mode='replaced';await expect(new ServiceWorkerClient({socket:fixture.path}).status()).rejects.toThrow();unlinkSync(fixture.path);renameSync(fixture.path+'.old',fixture.path);const run=join(fixture.root,'.cordis/run'),original=run+'.old';renameSync(run,original);symlinkSync(original,run);await expect(new ServiceWorkerClient({socket:fixture.path}).status()).rejects.toThrow();}finally{await fixture.close();}}
}
const suite=new ServiceObserverTestsIntegration();
test('integration: observer errors are bounded typed and sanitized',suite.failures.bind(suite),20000);
test('integration: socket modes identities replacements and symlinks fail closed',suite.paths.bind(suite));
