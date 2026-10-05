import { existsSync } from 'node:fs';
import { loadCatalog } from '../catalog/load.js';
import { paths } from '../core/paths.js';

export function availableCatalogSummary(
	stablePath = `${paths.catalogs}/stable.json`,
	developmentPath = `${paths.catalogs}/development.json`,
	reader: typeof loadCatalog = loadCatalog,
	fileExists: typeof existsSync = existsSync,
) {
	try {
		const stable = reader(stablePath);
		const development = fileExists(developmentPath) ? reader(developmentPath) : undefined;
		return {
			compatible: true as const,
			requiresCoreUpdate: false,
			stable: { release: stable.release, generation: stable.generation, digest: stable.catalogDigest },
			development: development ? { release: development.release, generation: development.generation, digest: development.catalogDigest } : null,
		};
	} catch {
		return { compatible: false as const, requiresCoreUpdate: true, stable: null, development: null };
	}
}
