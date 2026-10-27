import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from './release-fixture.js';
export class SourcePolicyTests {
    protected static sha(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    protected async fixture(): Promise<ServiceReleaseFixture> { const fixture = await new ServiceReleaseFixture().services(), directory = join(fixture.root, 'inspection-helper'); mkdirSync(directory); writeFileSync(join(directory, 'tool'), '#!/bin/sh\nexit 91\n', { mode: 0o500 }); await create({ cwd: directory, file: join(fixture.bundle, 'inspection-helper.tgz'), gzip: true, portable: false }, ['tool']); const bytes = readFileSync(join(fixture.bundle, 'inspection-helper.tgz')), helpers = { formatVersion: 1 as const, releaseIdentity: 'a'.repeat(64), helpers: [{ id: 'inspection-fixture', version: '1.0.0', platform: 'linux-amd64' as const, path: 'inspection-helper.tgz', sha256: SourcePolicyTests.sha(bytes), size: bytes.length, entry: 'tool', files: [{ path: 'tool', sha256: SourcePolicyTests.sha(readFileSync(join(directory, 'tool'))), mode: 0o500 as const }], libraryDirectories: [] }] }; helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: helpers.helpers }); fixture.release.helpers = helpers; const certificate = 'HASH_ONLY_PUBLIC_CA_INSPECTION_FIXTURE\n'; writeFileSync(join(fixture.bundle, 'source-ca.pem'), certificate); fixture.release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: helpers.releaseIdentity, npm: [{ registry: 'https://registry.npmjs.org/', packages: ['@fixture/z', '@fixture/a'], targets: ['deployment', 'cli'], certificateAuthority: { path: 'source-ca.pem', sha256: SourcePolicyTests.sha(certificate) } }], git: [], builds: [] }; fixture.refreshService(); return fixture; }
}
