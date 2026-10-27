import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import{tmpdir}from'node:os';
import{ServiceWorkerBuild}from'@treeseed-cordis/deployment';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
class StandaloneWorkerTests {
    prelude():void{const root=mkdtempSync(join(tmpdir(),'cordis-worker-prelude-'));try{const worker=ServiceWorkerBuild.produce(root),result=spawnSync(join(root,worker.path),['--invalid'],{encoding:'utf8',timeout:15000,env:{PATH:'/no-developer-tools',HOME:root}});if(result.status!==2||result.stdout!==''||result.stderr!=='')throw new Error('COLD_WORKER_PRELUDE:'+result.status+':'+result.stderr.slice(-2000));expect(result.status).toBe(2);}finally{rmSync(root,{recursive:true,force:true});}}

    async program(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running();
            const file = join(fixture.root, 'standalone-input.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const child = spawnSync('node', ['dist/tests/support/service-worker-program.js', file], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
            if (child.status !== 0) throw new Error(child.stderr);
            const report = JSON.parse(child.stdout);
            expect(report.fixtureOnly).toBe(true);
            expect(report.standalone).toBe(true);
            expect(report.ready).toBe(true);
            expect(report.services).toBe(5);
            expect(report.resourcesRetained).toBe(true);
            expect(report.replayed).toBe(true);
            expect(report.writerReleased).toBe(true);
        } finally { fixture.close(); }
    }
}
const suite = new StandaloneWorkerTests();
test("acceptance: genuine compiled worker applies five fixture services with Docker-only PATH and drains privately", suite.program.bind(suite), 240000);

test("acceptance: cold compiled worker loads its actual module prelude and rejects arguments without developer tools",suite.prelude.bind(suite),120000);
