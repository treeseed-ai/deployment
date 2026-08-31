import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, hostInitializationProfileSchema, integrationReleaseSchema, type ComponentRelease, type HostInitializationProfile, type IntegrationRelease } from '@treeseed/sdk/deployment';
import { sealCatalog } from './compile-catalog.js';

const artifacts = resolve(process.cwd(), '.treeseed/artifacts');
function integration(track: 'stable' | 'development') { return integrationReleaseSchema.parse(JSON.parse(readFileSync(resolve(artifacts, 'integrations', `${track}.json`), 'utf8'))); }
function components(lock: IntegrationRelease) {
	return lock.components.map((selected) => {
		const root = resolve(artifacts, 'components', selected.componentId, selected.release);
		const component = componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(root, 'component-release.json'), 'utf8')));
		if (component.componentId !== selected.componentId || component.release !== selected.release) throw new Error(`Integration selection ${selected.componentId}@${selected.release} does not match its component manifest.`);
		for (const file of selected.files) {
			const declared = component.runtime.compose.files.find((candidate) => candidate.path === file.path);
			if (!declared || declared.digest.slice(7) !== file.artifact.sha256) throw new Error(`${selected.componentId} file ${file.path} is not bound by its component runtime digest.`);
		}
		return component;
	});
}
function profiles(lock: IntegrationRelease): HostInitializationProfile[] {
	return lock.hostProfiles.map((selected) => {
		const profile = hostInitializationProfileSchema.parse(JSON.parse(readFileSync(resolve(artifacts, 'profiles', selected.id, 'profile.json'), 'utf8')));
		if (profile.id !== selected.id) throw new Error(`Integration host profile ${selected.id} does not match its artifact identity.`);
		return profile;
	});
}
function write(path: string, value: unknown) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

const stableLock = integration('stable'), stableComponents = components(stableLock);
if (stableComponents.some((component) => component.track !== 'stable')) throw new Error('Stable integration releases may contain only stable components.');
const stable = sealCatalog({ schemaVersion: 'treeseed.release-catalog/v1', release: stableLock.release, generation: stableLock.generation, track: 'stable', compatibilityId: stableLock.compatibilityId, stableBase: null, components: stableComponents, hostProfiles: profiles(stableLock), createdAt: stableLock.createdAt });

let developmentComponents: ComponentRelease[] = [];
let development;
try {
	const lock = integration('development');
	developmentComponents = components(lock).map((component) => componentReleaseSchema.parse({ ...component, stableBase: component.stableBase && { ...component.stableBase, catalogDigest: stable.catalogDigest } }));
	if (developmentComponents.some((component) => component.track !== 'development')) throw new Error('Development integration releases may contain only development components.');
	development = sealCatalog({ schemaVersion: 'treeseed.release-catalog/v1', release: lock.release, generation: lock.generation, track: 'development', compatibilityId: lock.compatibilityId, stableBase: { release: stable.release, catalogDigest: stable.catalogDigest }, components: developmentComponents, hostProfiles: profiles(lock), createdAt: lock.createdAt });
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
write(resolve(artifacts, 'catalogs/stable.json'), stable);
if (development) write(resolve(artifacts, 'catalogs/development.json'), development);
console.log(JSON.stringify({ ok: true, stable: stable.catalogDigest, development: development?.catalogDigest ?? null, profiles: { stable: stable.hostProfiles.map(({ id }) => id), development: development?.hostProfiles.map(({ id }) => id) ?? [] }, components: { stable: stableComponents.map(({ componentId }) => componentId), development: developmentComponents.map(({ componentId }) => componentId) } }));
