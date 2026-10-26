import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../src/diagnose.js';
import { ServiceReleaseFixture } from './release-fixture.js';
class SourcePolicyTests {
    private static sha(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    private async fixture(): Promise<ServiceReleaseFixture> { const fixture = await new ServiceReleaseFixture().services(), directory = join(fixture.root, 'inspection-helper'); mkdirSync(directory); writeFileSync(join(directory, 'tool'), '#!/bin/sh\nexit 91\n', { mode: 0o500 }); await create({ cwd: directory, file: join(fixture.bundle, 'inspection-helper.tgz'), gzip: true, portable: false }, ['tool']); const bytes = readFileSync(join(fixture.bundle, 'inspection-helper.tgz')), helpers = { formatVersion: 1 as const, releaseIdentity: 'a'.repeat(64), helpers: [{ id: 'inspection-fixture', version: '1.0.0', platform: 'linux-amd64' as const, path: 'inspection-helper.tgz', sha256: SourcePolicyTests.sha(bytes), size: bytes.length, entry: 'tool', files: [{ path: 'tool', sha256: SourcePolicyTests.sha(readFileSync(join(directory, 'tool'))), mode: 0o500 as const }], libraryDirectories: [] }] }; helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: helpers.helpers }); fixture.release.helpers = helpers; const certificate = 'HASH_ONLY_PUBLIC_CA_INSPECTION_FIXTURE\n'; writeFileSync(join(fixture.bundle, 'source-ca.pem'), certificate); fixture.release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: helpers.releaseIdentity, npm: [{ registry: 'https://registry.npmjs.org/', packages: ['@fixture/z', '@fixture/a'], targets: ['deployment', 'cli'], certificateAuthority: { path: 'source-ca.pem', sha256: SourcePolicyTests.sha(certificate) } }], git: [], builds: [] }; fixture.refreshService(); return fixture; }
    async program(): Promise<void> {
        const fixture = await this.fixture();
        try {
            const file = join(fixture.root, 'policy.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/source-policy-program.js', file], { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({ fixture: true, policy: true, normalized: true, deterministic: true, sourceFree: true, noRuntimeEffects: true });
        }
        finally {
            fixture.close();
        }
    }
    async forged(): Promise<void> { for (const mode of ['forged-policy', 'forged-helper']) {
        const fixture = await this.fixture();
        try {
            const file = join(fixture.root, 'forged-policy.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/source-policy-program.js', file, mode], { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({ fixture: true, forgedMetadataRefused: true, noRuntimeEffects: true });
        }
        finally {
            fixture.close();
        }
    } }
    async blocked(): Promise<void> {
        for (const mode of ['helper', 'certificate', 'symlink', 'build']) {
            const fixture = await this.fixture();
            try {
                if (mode === 'helper')
                    fixture.release.acquisitionPolicy!.helperReleaseIdentity = 'f'.repeat(64);
                if (mode === 'certificate')
                    writeFileSync(join(fixture.bundle, 'source-ca.pem'), 'TAMPERED');
                if (mode === 'symlink') {
                    unlinkSync(join(fixture.bundle, 'source-ca.pem'));
                    symlinkSync(join(fixture.root, 'inspection-helper/tool'), join(fixture.bundle, 'source-ca.pem'));
                }
                if (mode === 'build') {
                    const policy = fixture.release.acquisitionPolicy!;
                    policy.git = [{ origin: 'https://github.com/fixture/plugin.git', packages: ['@fixture/plugin'], targets: ['deployment'], buildPolicyDigest: 'b'.repeat(64) }];
                    policy.builds = [{ id: 'b'.repeat(64), origin: policy.git[0]!.origin, commit: 'c'.repeat(40), entry: 'build.ts', entryDigest: 'd'.repeat(64), packageDirectory: 'package', image: 'registry.invalid/build@sha256:' + 'e'.repeat(64), helperReleaseIdentity: policy.helperReleaseIdentity, network: 'none', timeoutMs: 120000 }];
                }
                fixture.refreshService();
                await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toThrow();
                expect(existsSync(fixture.installation)).toBe(false);
            }
            finally {
                fixture.close();
            }
        }
    }
}
const suite = new SourcePolicyTests();
test('smoke: default built planner preserves normalized exact source policy without runtime changes and reads source-free', suite.program.bind(suite), 60000);
test('integration: source policy wrong helpers changed CA symlinks and unbound build identities block before persistence', suite.blocked.bind(suite), 60000);
test('smoke: genuine default host rejects re-signed source-policy and helper metadata before staging', suite.forged.bind(suite), 60000);
