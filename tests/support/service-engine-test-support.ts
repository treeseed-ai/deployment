import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ComposeDeploymentHost, ServiceExecution } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
export class EngineTests {
    protected static service(value: {
        serviceId: string;
    }): string { return value.serviceId; }
    protected static resource(value: {
        resourceId: string;
    }): string { return value.resourceId; }
    protected static container(value: {
        kind: string;
    }): boolean { return value.kind === 'container'; }
    protected static volume(value: {
        kind: string;
    }): boolean { return value.kind === 'volume'; }
    protected static network(value: {
        kind: string;
    }): boolean { return value.kind === 'network'; }
    protected static secret(value: {
        kind: string;
    }): boolean { return ['secret', 'configuration'].includes(value.kind); }
}
