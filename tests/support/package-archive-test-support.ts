import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture, PreparedReleaseFixture } from './release-fixture.js';
