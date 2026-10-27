import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages } from '../../src/diagnose.js';
