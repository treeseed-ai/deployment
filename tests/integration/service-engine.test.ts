import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ComposeDeploymentHost, ServiceExecution } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import {EngineTests} from '../support/service-engine-test-support.js';
class EngineTestsIntegration extends EngineTests {

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
}
const suite=new EngineTestsIntegration();
test('integration: service contexts return independent accepted data and exact dependency bindings', suite.contexts.bind(suite), 30000);
