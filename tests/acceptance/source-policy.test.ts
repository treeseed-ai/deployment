import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import {SourcePolicyTests} from '../support/source-policy-test-support.js';
class SourcePolicyTestsAcceptance extends SourcePolicyTests {

    async program(): Promise<void> {
        const fixture = await this.fixture();
        try {
            const file = join(fixture.root, 'policy.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/support/source-policy-program.js', file], { encoding: 'utf8', timeout: 30000 });
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
            const result = spawnSync('node', ['dist/tests/support/source-policy-program.js', file, mode], { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({ fixture: true, forgedMetadataRefused: true, noRuntimeEffects: true });
        }
        finally {
            fixture.close();
        }
    } }
}
const suite=new SourcePolicyTestsAcceptance();
test("acceptance: default built planner preserves normalized exact source policy without runtime changes and reads source-free", suite.program.bind(suite), 60000);
test("acceptance: genuine default host rejects re-signed source-policy and helper metadata before staging", suite.forged.bind(suite), 60000);
