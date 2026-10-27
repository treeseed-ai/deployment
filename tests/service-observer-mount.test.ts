import { test, expect } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { mkdirSync, chmodSync, linkSync, unlinkSync, renameSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ObserverServiceFixture } from './service-observer-fixture.js';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { ServiceObserverMount } from '../src/service-observer-mount.js';
class ObserverMountTests {
    private server: Server | null = null; private socket = '';
    private listen(accept: (value: void) => void): void { this.server!.listen(this.socket, accept); }
    private close(accept: (value: void) => void): void { this.server!.close(this.closed.bind(this, accept)); }
    private closed(accept: (value: void) => void): void { accept(); }
    async program():Promise<void>{const fixture=new ObserverServiceFixture();try{await fixture.prepared();const file=join(fixture.root,'observer.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-observer-program.js',file],{encoding:'utf8',timeout:150000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,observerRead:true,readonly:true,ownerDenied:true,measuredEntry:true,sourceFree:true,retained:true});}finally{fixture.close();}}
    async race():Promise<void>{const fixture=new ObserverServiceFixture();try{await fixture.prepared();const file=join(fixture.root,'observer-race.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/service-observer-program.js',file,'race'],{encoding:'utf8',timeout:150000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,raceRejected:true,started:false,repairRequired:true});}finally{fixture.close();}}
    async admission(): Promise<void> {
        const fixture = await new ServiceReleaseFixture().services(); let anchor: ServiceObserverMount | null = null;
        try {
            const plan = await new ComposeDeploymentHost().plan(fixture.configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format');
            const service = plan.composition.services[0]!; service.definition.workerSocket = true; service.definition.user = 'installation-owner'; plan.composition.profile.workerSocketServiceId = service.serviceId; plan.runtimeBindings = { [service.serviceId]: { packageSetDigest: 'a'.repeat(64), entryDigest: 'b'.repeat(64), imageManifestDigest: 'c'.repeat(64) } };
            expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow();
            const run = join(fixture.installation, '.cordis/run'); mkdirSync(run, { mode: 0o700 }); this.socket = join(run, 'host.sock'); this.server = createServer(); await new Promise<void>(this.listen.bind(this)); chmodSync(this.socket, 0o600);
            anchor = ServiceObserverMount.open(plan, service); expect(anchor).not.toBeNull(); expect(anchor!.argument()).toContain('target=/run/cordis-host,readonly'); anchor!.verify();
            const first = anchor!.digest, repeated = ServiceObserverMount.open(plan, service); expect(repeated!.digest).toBe(first); repeated!.close();
            chmodSync(this.socket, 0o644); expect(anchor!.verify.bind(anchor)).toThrow(); chmodSync(this.socket, 0o600);
            const linked = join(run, 'alias.sock'); linkSync(this.socket, linked); expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow(); unlinkSync(linked);
            const backup = this.socket + '.held'; renameSync(this.socket, backup); symlinkSync(backup, this.socket); expect(anchor!.verify.bind(anchor)).toThrow(); unlinkSync(this.socket); renameSync(backup, this.socket);
            service.definition.secrets.push({ slot: 'cover', target: '/run' }); expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow(); service.definition.secrets = [];
            plan.composition.profile.workerSocketServiceId = 'unselected'; expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow(); plan.composition.profile.workerSocketServiceId = service.serviceId;
            service.definition.user = 'image-default'; expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow(); service.definition.user = 'installation-owner';
            delete plan.runtimeBindings; expect(ServiceObserverMount.open.bind(ServiceObserverMount, plan, service)).toThrow();
            expect(lstatSync(this.socket).isSocket()).toBe(true);
        } finally { anchor?.close(); if (this.server) await new Promise<void>(this.close.bind(this)); fixture.close(); }
    }
}
const observerMounts = new ObserverMountTests();
test('integration: observer mount admission pins private directory socket and exact runtime grant without Docker effects', observerMounts.admission.bind(observerMounts), 30000);

test('smoke: granted real container reads native host observations with no owner control and retains source-free state',observerMounts.program.bind(observerMounts),240000);

test('smoke: observer socket replacement restored during real container creation fails before start with repair state',observerMounts.race.bind(observerMounts),240000);
