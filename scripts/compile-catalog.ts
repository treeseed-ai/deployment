import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentReleaseSchema, deploymentDigest, releaseCatalogSchema, type ComponentRelease, type ReleaseCatalog } from '@treeseed/sdk/deployment';

export function sealCatalog(catalog: Omit<ReleaseCatalog, 'catalogDigest'>): ReleaseCatalog {
	const material = { ...catalog, catalogDigest: 'sha256:'.padEnd(71, '0') };
	return releaseCatalogSchema.parse({ ...catalog, catalogDigest: deploymentDigest(material) });
}

function argument(name: string) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function compatibleRange(range: string, release: string) {
	const match = range.match(/^>=([0-9]+)\.([0-9]+)\.([0-9]+) <([0-9]+)\.([0-9]+)\.([0-9]+)$/u);
	const version = release.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)/u);
	if (!match || !version) return false;
	const value = version.slice(1).map(Number), minimum = match.slice(1, 4).map(Number), maximum = match.slice(4, 7).map(Number);
	const compare = (left: number[], right: number[]) => { for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!; return 0; };
	return compare(value, minimum) >= 0 && compare(value, maximum) < 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const track = argument('--track');
	if (track !== 'stable' && track !== 'development') throw new Error('Usage: compile-catalog --track stable|development --release VERSION --generation NUMBER --component FILE... --output FILE [--stable FILE]');
	const release = argument('--release'), generation = Number(argument('--generation')), output = argument('--output');
	if (!release || !Number.isInteger(generation) || generation < 1 || !output) throw new Error('Release, positive generation, and output are required.');
	const components: ComponentRelease[] = [];
	for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === '--component') components.push(componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(process.argv[index + 1]!), 'utf8'))));
	if (components.length === 0) throw new Error('At least one verified component release is required.');
	if (components.some((component) => component.track !== track)) throw new Error('Every component release must match the catalog track.');
	let stableBase: ReleaseCatalog['stableBase'] = null;
	if (track === 'development') {
		const stablePath = argument('--stable');
		if (!stablePath) throw new Error('Development catalogs require an exact stable catalog.');
		const stable = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(stablePath), 'utf8')));
		stableBase = { release: stable.release, catalogDigest: stable.catalogDigest };
		for (const [index, component] of components.entries()) {
			if (!component.stableBase || component.stableBase.compatibilityId !== stable.compatibilityId || !compatibleRange(component.stableBase.releaseRange, stable.release)) throw new Error(`Development component ${component.componentId} is incompatible with the selected stable base.`);
			if (component.stableBase.catalogDigest && component.stableBase.catalogDigest !== stable.catalogDigest) throw new Error(`Development component ${component.componentId} is already bound to a different stable base.`);
			components[index] = componentReleaseSchema.parse({ ...component, stableBase: { ...component.stableBase, catalogDigest: stable.catalogDigest } });
		}
	}
	const catalog = sealCatalog({ schemaVersion: 'treeseed.release-catalog/v1', release, generation, track, compatibilityId: 'treeseed-linux-amd64-v1', stableBase, components, createdAt: new Date().toISOString() });
	mkdirSync(dirname(resolve(output)), { recursive: true });
	writeFileSync(resolve(output), `${JSON.stringify(catalog, null, 2)}\n`);
	console.log(JSON.stringify({ ok: true, track, generation, catalogDigest: catalog.catalogDigest, components: components.map((component) => component.componentId), output: resolve(output) }));
}
