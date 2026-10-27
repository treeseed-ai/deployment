import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ServiceProjection } from '../../src/service-projection.js';
import { CredentialContainerFixture } from './service-fixture-plugins.js';
import { ServiceSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceCredentials } from '../../src/diagnose.js';
