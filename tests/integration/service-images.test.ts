import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages } from '../../src/diagnose.js';
class ServiceImageTestsIntegration {

    async failures(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer();
        try {
            const images = new ServiceImages(plan);
            await expect(images.stage(writer)).rejects.toThrow();
            expect(existsSync(join(fixture.installation, '.cordis/artifacts'))).toBe(false);
            const record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'image-blocks' }, writer).record;
            store.append({ ...record, sequence: 1, phase: 'stage', result: null }, writer);
            const file = join(fixture.bundle, 'oci/blobs/sha256', fixture.release.images[0]!.manifestDigest), bytes = readFileSync(file);
            writeFileSync(file, 'changed');
            await expect(images.stage(writer)).rejects.toThrow();
            expect(existsSync(join(fixture.installation, '.cordis/artifacts'))).toBe(false);
            writeFileSync(file, bytes);
            await images.stage(writer);
            const cache = join(fixture.installation, '.cordis/artifacts/images'), binding = join(cache, fixture.release.images[0]!.manifestDigest, 'binding.json'), saved = readFileSync(binding);
            mkdirSync(join(cache, 'building-uncertain'), { mode: 0o700 });
            await expect(images.stage(writer)).rejects.toThrow();
            expect(readFileSync(binding).equals(saved)).toBe(true);
            rmSync(join(cache, 'building-uncertain'), { recursive: true });const tar=join(cache,fixture.release.images[0]!.manifestDigest,'image.tar');chmodSync(tar,0o644);await expect(images.stage(writer)).rejects.toThrow();chmodSync(tar,0o600);
            mkdirSync(join(cache, 'f'.repeat(64)), { mode: 0o700 });
            await expect(images.stage(writer)).rejects.toThrow();
            expect(readFileSync(binding).equals(saved)).toBe(true);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServiceImageTestsIntegration();
test('integration: image preparation rejects unaccepted tampered and incomplete input without overwrite', suite.failures.bind(suite), 120000);
