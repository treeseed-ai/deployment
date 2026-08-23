import { readFileSync } from 'node:fs';
import { deploymentDigest, releaseCatalogSchema, type ReleaseCatalog } from '@treeseed/sdk/deployment';

export function loadCatalog(path: string): ReleaseCatalog {
	const catalog = releaseCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	const declared = catalog.catalogDigest;
	const material = { ...catalog, catalogDigest: 'sha256:'.padEnd(71, '0') };
	if (deploymentDigest(material) !== declared) throw new Error(`Catalog digest mismatch for ${path}.`);
	return catalog;
}
