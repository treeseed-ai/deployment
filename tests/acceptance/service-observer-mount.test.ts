import { test, expect } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { mkdirSync, chmodSync, linkSync, unlinkSync, renameSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ObserverServiceFixture } from '../support/service-observer-fixture.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { ServiceObserverMount } from '../../src/service-observer-mount.js';
import {ObserverMountTests} from '../support/service-observer-mount-test-support.js';
class ObserverMountTestsAcceptance extends ObserverMountTests {

    async program():Promise<void>{const fixture=new ObserverServiceFixture();try{await fixture.prepared();const file=join(fixture.root,'observer.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/support/service-observer-program.js',file],{encoding:'utf8',timeout:150000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,observerRead:true,readonly:true,ownerDenied:true,measuredEntry:true,sourceFree:true,retained:true});}finally{fixture.close();}}

    async race():Promise<void>{const fixture=new ObserverServiceFixture();try{await fixture.prepared();const file=join(fixture.root,'observer-race.json');writeFileSync(file,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/support/service-observer-program.js',file,'race'],{encoding:'utf8',timeout:150000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,raceRejected:true,started:false,repairRequired:true});}finally{fixture.close();}}
}
const observerMounts=new ObserverMountTestsAcceptance();
test("acceptance: granted real container reads native host observations with no owner control and retains source-free state",observerMounts.program.bind(observerMounts),240000);
test("acceptance: observer socket replacement restored during real container creation fails before start with repair state",observerMounts.race.bind(observerMounts),240000);
