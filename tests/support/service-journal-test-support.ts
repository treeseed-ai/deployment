import { test, expect } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore } from '../../src/diagnose.js';
import { CanonicalJson, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
export class ServiceJournalTests {
    static changed(plan: ServicePlan): ServicePlan { const { id: _id, digest: _digest, ...payload } = structuredClone(plan); payload.configuration.runtimeState = 'stopped'; payload.configurationDigest = CanonicalJson.digest(payload.configuration); payload.compositionGeneration = CanonicalJson.digest({ configuration: payload.configuration, composition: payload.composition, expectedEngine: payload.expectedEngine, artifacts: payload.artifacts }); const digest = CanonicalJson.digest(payload); return ServiceSchemas.plan.parse({ ...payload, id: 'plan-' + digest, digest }); }
}
