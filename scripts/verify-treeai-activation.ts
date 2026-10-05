import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { componentReleaseSchema, hostConfigurationSchema, integrationReleaseSchema, type ComponentRelease } from '@treeseed/sdk/deployment';
import { managedConnectionEnvironment } from '../src/manager/reconcile.js';
import { managedRuntimeInputEnvironment } from '../src/manager/runtime-inputs.js';
import { renderComponentEnvironment } from '../src/supervisor/component.js';

const artifactRoot = resolve('.treeseed/artifacts');
const lock = integrationReleaseSchema.parse(JSON.parse(readFileSync(resolve(artifactRoot, 'integrations/development.json'), 'utf8')));
const selections = lock.components.filter(({ componentId }) => componentId.startsWith('ai-'));
if (selections.length !== 3) throw new Error('The development lock must select all three TreeAI components.');
const releases = selections.map(({ componentId, release }) => componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(artifactRoot, 'components', componentId, release, 'component-release.json'), 'utf8'))));

const profilePath = process.env.TREESEED_TREEAI_PROFILE;
const profile = profilePath ? JSON.parse(readFileSync(resolve(profilePath), 'utf8')) as Record<string, any> : undefined;
const components: Record<string, any> = profile ? profile.components : {};
const secrets: Record<string, any> = profile ? profile.secrets : {};
for (const component of releases) {
	if (profile) continue;
	const environment: Record<string, string> = {}, secretEnvironment: Record<string, string> = {};
	for (const declaration of component.runtime.configuration.environment) {
		if (declaration.source === 'configuration' && declaration.default === undefined && declaration.required) environment[declaration.name] = `fixture-${declaration.name.toLowerCase()}`;
	}
	for (const declaration of component.runtime.configuration.secretEnvironment) {
		const secretId = `${component.componentId}-${declaration.name.toLowerCase().replaceAll('_', '-')}`;
		secretEnvironment[declaration.name] = secretId;
		secrets[secretId] = { provider: 'file', reference: `/etc/treeseed/credentials/${secretId}` };
	}
	for (const declaration of component.runtime.configuration.secretFiles) secrets[declaration.id] = { provider: 'file', reference: declaration.path };
	components[component.componentId] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: { environment, secretEnvironment } };
}
if (!profile) components['ai-lab'].connections = {
	inference: { kind: 'local', componentId: 'ai-inference', serviceId: 'inference-api', endpointId: 'inference' },
	training: { kind: 'local', componentId: 'ai-training', serviceId: 'training-api', endpointId: 'control' },
};
const host = hostConfigurationSchema.parse({
	schemaVersion: 'treeseed.host/v1', configurationId: 'treeai-activation-fixture', generation: 1,
	host: { id: 'treeai-activation-fixture', role: 'integrated', architecture: 'amd64' }, runtime: { management: 'managed', environment: 'production' },
	updates: { defaultTrack: 'development', stable: { metadataPollSeconds: 86_400, maintenanceWindow: { weekday: 'sunday', localTime: '03:00', jitterMinutes: 30 } }, development: { pollSeconds: 60 } },
	components, network: { manager: { binding: '127.0.0.1:4790', aliases: ['manager.treeseed.localhost'], sans: ['manager.treeseed.localhost'], trustedLanCidrs: [] } },
	fleet: { rolloutGroup: 'activation-fixture', receiptReporting: { enabled: false, intervalSeconds: 300 } }, secrets,
});

function activate(component: ComponentRelease) {
	const connections = managedConnectionEnvironment(host, component, releases);
	const runtime = managedRuntimeInputEnvironment(host, component, { runtimeGid: () => 991 });
	for (const key of Object.keys(runtime)) if (connections[key] !== undefined) throw new Error(`Runtime input ${key} conflicts with a managed connection.`);
	const environment = renderComponentEnvironment(host, component.componentId, { ...connections, ...runtime }, () => 'fixture-secret-not-persisted');
	const root = mkdtempSync(resolve(tmpdir(), `treeseed-${component.componentId}-activation-`));
	try {
		const environmentPath = resolve(root, 'environment');
		writeFileSync(environmentPath, environment, { mode: 0o600 });
		const publishedCompose = resolve(artifactRoot, 'components', component.componentId, component.release, component.runtime.compose.files[0]!.path);
		const compose = resolve(root, 'compose.yml');
		const managedEnvironmentPath = `/etc/treeseed/components/${component.componentId}/environment`;
		const source = readFileSync(publishedCompose, 'utf8');
		writeFileSync(compose, source.replaceAll(managedEnvironmentPath, environmentPath));
		execFileSync('/usr/bin/docker', ['compose', '--env-file', environmentPath, '-f', compose, 'config', '--quiet'], { stdio: 'pipe' });
	} finally { rmSync(root, { recursive: true, force: true }); }
	return { componentId: component.componentId, release: component.release, publicEnvironment: Object.keys({ ...connections, ...runtime }).sort(), secretEnvironment: component.runtime.configuration.secretEnvironment.map(({ name }) => name).sort(), secretFiles: component.runtime.configuration.secretFiles.map(({ id }) => id).sort() };
}

console.log(JSON.stringify({ status: 'ready', components: releases.map(activate) }, null, 2));
