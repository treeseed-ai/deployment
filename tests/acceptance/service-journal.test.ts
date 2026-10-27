import { test, expect } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore } from '../../src/diagnose.js';
import { CanonicalJson, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
import {ServiceJournalTests} from '../support/service-journal-test-support.js';
class ServiceJournalTestsAcceptance extends ServiceJournalTests {

    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const input = join(fixture.root, 'journal-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-journal-program.js', input], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout).fixtureOnly).toBe(true);
        const store = new ServicePlanStore(fixture.installation), record = store.records()[0]!;
        expect(record.phase).toBe('completed');
        expect(store.current()!.compositionGeneration).toBe(record.activeComposition!);
        const resource = store.resources()[0]!;
        expect(resource.actualId).toBe('fixture-observation-only');
        const writer = store.writer();
        try {
            expect(store.saveResource.bind(store, { ...resource, actualId: 'foreign-container' }, writer)).toThrow();
            const snapshot = store.current()!;
            expect(store.saveSnapshot.bind(store, { ...snapshot, acknowledgements: [] }, writer)).toThrow();
            expect(store.saveSnapshot.bind(store, { ...snapshot, installationId: 'foreign' }, writer)).toThrow();
            const accepted = store.accept({ protocol: 3, operation: 'submit', planId: record.planId, digest: record.digest, idempotencyKey: record.idempotencyKey }, writer);
            expect(accepted.fresh).toBe(false);
            expect(accepted.record.id).toBe(record.id);
            expect(store.accept.bind(store, { protocol: 3, operation: 'submit', planId: record.planId, digest: record.digest, idempotencyKey: 'stale-new-request' }, writer)).toThrow();
        }
        finally {
            writer.close();
        }
        for (const folder of ['applications', 'resources', 'snapshots']) {
            expect(statSync(join(fixture.installation, '.cordis', folder)).mode & 0o777).toBe(0o700);
            for (const name of readdirSync(join(fixture.installation, '.cordis', folder)))
                expect(statSync(join(fixture.installation, '.cordis', folder, name)).mode & 0o777).toBe(0o600);
        }
        const report = await new ComposeDeploymentHost().diagnose({ installationDirectory: fixture.installation, port: 58443 });
        let storage = false;
        for (const check of report.checks)
            if (check.id === 'storage' && check.status === 'pass')
                storage = true;
        expect(storage).toBe(true);
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServiceJournalTestsAcceptance();
test("acceptance: built format3 journal persists fixture observations and reads without source", suite.program.bind(suite), 30000);
