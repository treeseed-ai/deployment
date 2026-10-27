import { test, expect } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore } from '../../src/diagnose.js';
import { CanonicalJson, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
import {ServiceJournalTests} from '../support/service-journal-test-support.js';
class ServiceJournalTestsIntegration extends ServiceJournalTests {

    async authority(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer();
        try {
            expect(store.writer.bind(store)).toThrow();
            expect(store.publish(plan, writer).id).toBe(plan.id);
            const intent = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'request-a' }, accepted = store.accept(intent, writer);
            expect(store.accept(intent, writer).fresh).toBe(false);
            expect(store.accept.bind(store, { ...intent, idempotencyKey: 'request-b' }, writer)).toThrow();
            const altered = ServiceJournalTests.changed(plan);
            store.publish(altered, writer);
            expect(store.accept.bind(store, { ...intent, planId: altered.id, digest: altered.digest }, writer)).toThrow();
            const before = readdirSync(join(fixture.installation, '.cordis/applications'));
            expect(store.append.bind(store, { ...accepted.record, sequence: 1, phase: 'completed', result: 'ready', activeComposition: plan.compositionGeneration }, writer)).toThrow();
            expect(readdirSync(join(fixture.installation, '.cordis/applications'))).toEqual(before);
        }
        finally {
            writer.close();
        }
        expect(store.inspect()).toBe(true);
    }
    finally {
        fixture.close();
    } }

    async corruption(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer();
        try {
            const accepted = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'uncertain' }, writer);
            store.append({ ...accepted.record, sequence: 1, phase: 'failed', result: 'failed', recovery: 'repair-required' }, writer);
            expect(store.accept.bind(store, { protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'later' }, writer)).toThrow();
        }
        finally {
            writer.close();
        }
        const directory = join(fixture.installation, '.cordis/applications'), name = readdirSync(directory).sort()[0]!, path = join(directory, name), bytes = readFileSync(path);
        chmodSync(path, 0o644);
        expect(store.inspect.bind(store)).toThrow();
        chmodSync(path, 0o600);
        writeFileSync(path, '{}');
        expect(store.inspect.bind(store)).toThrow();
        writeFileSync(path, bytes);
        unlinkSync(path);
        expect(store.inspect.bind(store)).toThrow();
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServiceJournalTestsIntegration();
test('integration: one writer binds retries conflicts and forbids unobserved completion', suite.authority.bind(suite));
test('integration: uncertain interrupted malformed and nonprivate journal state fences reuse', suite.corruption.bind(suite));
