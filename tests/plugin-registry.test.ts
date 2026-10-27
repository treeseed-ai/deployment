import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
class PluginRegistryTests {
    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const path = join(fixture.root, 'registry-input.json');
        writeFileSync(path, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/plugin-registry-program.js', path], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixture: true, persistedIntent: true, retry: true, resolutionPinned: true, sourceFree: true, tamperRefused: true });
    }
    finally {
        fixture.close();
    } }
}
const suite = new PluginRegistryTests();
test('smoke: built owner request registry persists intent and exact retry custody without source or runtime effects', suite.program.bind(suite), 60000);
