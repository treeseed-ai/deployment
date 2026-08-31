import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { sealCatalog } from '../scripts/compile-catalog.js';
import { stableCatalogDebianVersion } from '../scripts/catalog-package-version.js';
import { loadCatalog } from '../src/catalog/load.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function stable() {
	return {
		schemaVersion: 'treeseed.release-catalog/v1' as const,
		release: '0.1.0',
		generation: 36,
		track: 'stable' as const,
		compatibilityId: 'treeseed-linux-amd64-v1',
		stableBase: null,
		components: [],
		hostProfiles: [],
		createdAt: '2026-08-31T00:00:00.000Z',
	};
}

describe('catalog identity', () => {
	it('seals the same schema-normalized representation that the manager verifies', () => {
		const catalog = sealCatalog(stable());
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-catalog-')); roots.push(root);
		const path = resolve(root, 'stable.json'); writeFileSync(path, `${JSON.stringify(catalog)}\n`);
		expect(loadCatalog(path)).toEqual(catalog);
		const material = { ...catalog, catalogDigest: 'sha256:'.padEnd(71, '0') };
		expect(catalog.catalogDigest).toBe(deploymentDigest(material));
	});

	it('changes Debian identity when canonical catalog content changes at one generation', () => {
		const first = sealCatalog(stable());
		const second = sealCatalog({ ...stable(), createdAt: '2026-08-31T00:00:01.000Z' });
		expect(first.generation).toBe(second.generation);
		expect(stableCatalogDebianVersion(first)).not.toBe(stableCatalogDebianVersion(second));
		expect(stableCatalogDebianVersion(first)).toMatch(/^0\.1\.0-36\+catalog\.[a-f0-9]{12}$/u);
	});
});
