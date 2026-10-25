import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ComposeDeploymentHost, ServiceExecution } from '../src/diagnose.js';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class EngineTests {
    async program(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running();
        const file = join(fixture.root, 'input.json');
        writeFileSync(file, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-engine-program.js', file], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        const report = JSON.parse(result.stdout);
        expect(report.fixtureOnly).toBe(true);
        expect(report.ready).toBe(false);
        expect(new Set(report.identities.map(EngineTests.service)).size).toBe(5);
        expect(new Set(report.identities.map(EngineTests.resource)).size).toBe(5);
        expect(report.resources.filter(EngineTests.container)).toHaveLength(5);
        expect(report.resources.filter(EngineTests.volume)).toHaveLength(5);
        expect(report.resources.filter(EngineTests.network)).toHaveLength(1);
        expect(report.resources.filter(EngineTests.secret)).toHaveLength(15);
    }
    finally {
        fixture.close();
    } }
    async contexts(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const context = new ServiceExecution(plan, 'instance-2'), first = context.service;
        first.serviceId = 'other';
        first.resources.grants.length = 0;
        plan.composition.services[2]!.dependencies.length = 0;
        expect(context.service.serviceId).toBe('instance-2');
        expect(context.dependency('primary').serviceId).toBe('instance-0');
        const dependency = context.dependency('primary');
        Reflect.set(dependency.endpoints, 'http', 'foreign');
        expect(context.dependency('primary').endpoints.http).toBe('instance-0:8080');
        expect(context.dependency.bind(context, 'foreign')).toThrow();
    }
    finally {
        fixture.close();
    } }
    private static service(value: {
        serviceId: string;
    }): string { return value.serviceId; }
    private static resource(value: {
        resourceId: string;
    }): string { return value.resourceId; }
    private static container(value: {
        kind: string;
    }): boolean { return value.kind === 'container'; }
    private static volume(value: {
        kind: string;
    }): boolean { return value.kind === 'volume'; }
    private static network(value: {
        kind: string;
    }): boolean { return value.kind === 'network'; }
    private static secret(value: {
        kind: string;
    }): boolean { return ['secret', 'configuration'].includes(value.kind); }
}
const suite = new EngineTests();
test('smoke: built bounded engine starts five disposable instances with exact private mounts and stable receipts', suite.program.bind(suite), 240000);
test('integration: service contexts return independent accepted data and exact dependency bindings', suite.contexts.bind(suite), 30000);
