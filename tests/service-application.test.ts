import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
import { ServiceReleaseFixture } from './release-fixture.js';
interface ApplicationReport {
    fixtureOnly: boolean;
    ready: boolean;
    application: {
        phase: string;
        result: string;
    };
    resourceCount: number;
    status: {
        services: unknown[];
    };
    downReady?: boolean;
}
class ApplicationTests {
    private program(fixture: ServiceReleaseFixture, expected = 'completed'): ApplicationReport {
        const file = join(fixture.root, 'application-input.json');
        writeFileSync(file, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-application-program.js', file, expected], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        return JSON.parse(result.stdout);
    }
    async running(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running();
            const report = this.program(fixture);
            expect(report.fixtureOnly).toBe(true);
            expect(report.ready).toBe(true);
            expect(report.application.phase).toBe('completed');
            expect(report.application.result).toBe('ready');
            expect(report.resourceCount).toBe(26);
            expect(report.status.services).toHaveLength(5);
            expect(report.downReady).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
    async failed(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running(true);
            const report = this.program(fixture, 'failed');
            expect(report.ready).toBe(false);
            expect(report.application.phase).toBe('failed');
            expect(report.resourceCount).toBeGreaterThan(0);
            expect(report.status.services).toHaveLength(0);
        }
        finally {
            fixture.close();
        }
    }
    async port(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running();
            const report = this.program(fixture, 'port-conflict');
            expect(report.ready).toBe(false);
            expect(report.application.phase).toBe('failed');
            expect(report.resourceCount).toBe(0);
        }
        finally {
            fixture.close();
        }
    }
    async drain(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.services();
        const report = this.program(fixture, 'drain-only');
        expect(report.application.phase).toBe('none');
        expect(report.fixtureOnly).toBe(true);
        expect(report.resourceCount).toBe(0);
    }
    finally {
        fixture.close();
    } }
    async stopped(): Promise<void> {
        const fixture = new ServiceReleaseFixture();
        try {
            await fixture.services();
            fixture.configuration.runtimeState = 'stopped';
            const report = this.program(fixture);
            expect(report.fixtureOnly).toBe(true);
            expect(report.ready).toBe(false);
            expect(report.application.result).toBe('stopped');
            expect(report.resourceCount).toBe(0);
        }
        finally {
            fixture.close();
        }
    }
}
const suite = new ApplicationTests();
test('smoke: built default application root durably commits five native protocol-qualified services and reports subsequent failure', suite.running.bind(suite), 240000);
test('smoke: built default application root preserves a stopped non-serving composition', suite.stopped.bind(suite), 120000);
test('smoke: unready partial application retains evidence and refuses implicit repair', suite.failed.bind(suite), 240000);
test('smoke: an occupied publication blocks application before staging or runtime effects', suite.port.bind(suite), 120000);
test('smoke: pending host close cannot report cleanup and can finish after native leases settle', suite.drain.bind(suite), 30000);
