import { createHash } from 'node:crypto';
import { deploymentDigest, hostedStateBackendSchema, hostedTopologyDeclarationSchema, type HostedResourceObservation, type HostedTopologyDeclaration } from '@treeseed/sdk/deployment';
import { hostedInfrastructureAuthorityEnvironment, type HostedInfrastructureAuthorityRequest, type HostedInfrastructureVaultAuthority } from './authority.js';
import { resolveHostedInfrastructureParameter, requiredInfrastructureString } from './parameters.js';
import type { HostedInfrastructureWorkspace } from './workspace.js';

type Resource = HostedTopologyDeclaration['resources'][number];
type Connections = Record<string, { connectionRef: string; nonSecretConfig: Record<string, string | number | boolean> }>;
const cloudflareApi = 'https://api.cloudflare.com/client/v4';
const railwayApi = 'https://backboard.railway.com/graphql/v2';

function profile(provider: Resource['provider'], kind: Resource['kind']) {
	if (provider === 'railway') return { credentialProfileId: 'railway-workspace' as const, capability: kind === 'postgresql' ? 'database-hosting' : kind === 'treedx-service' ? 'private-knowledge-index-hosting' : 'backend-hosting' };
	return ['dns-record', 'tls-policy'].includes(kind) ? { credentialProfileId: 'cloudflare-dns' as const, capability: 'dns-management' } : { credentialProfileId: 'cloudflare-runtime' as const, capability: 'frontend-hosting' };
}

export function hostedInfrastructureDiscoveryRequests(input: { declaration: HostedTopologyDeclaration; stateBackend: unknown }) {
	const declaration = hostedTopologyDeclarationSchema.parse(input.declaration), backend = hostedStateBackendSchema.parse(input.stateBackend);
	if (backend.teamId !== declaration.teamId || backend.deploymentId !== declaration.deploymentId || backend.stackId !== declaration.stackId || backend.environment !== declaration.environment) throw new Error('Hosted discovery backend custody does not match its declaration.');
	const requests = new Map<string, HostedInfrastructureAuthorityRequest>();
	for (const resource of declaration.resources) {
		const binding = declaration.providerConnections[resource.provider]; if (!binding) throw new Error(`Hosted discovery has no ${resource.provider} connection.`);
		const selected = profile(resource.provider, resource.kind), requestId = `${binding.connectionRef}:${selected.credentialProfileId}`, existing = requests.get(requestId);
		if (existing) existing.capabilities = [...new Set([...existing.capabilities, selected.capability])].sort();
		else requests.set(requestId, { requestId, teamId: declaration.teamId, deploymentId: declaration.deploymentId, stackId: declaration.stackId, environment: declaration.environment, backendBindingDigest: backend.bindingDigest, provider: resource.provider, connectionRef: binding.connectionRef, credentialProfileId: selected.credentialProfileId, capabilities: [selected.capability], purpose: 'provider' });
	}
	return [...requests.values()].sort((left, right) => left.requestId.localeCompare(right.requestId));
}

function parameter(resource: Resource, name: string, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	return resolveHostedInfrastructureParameter(resource.parameters[name], context);
}

async function cloudflareJson(fetchImpl: typeof fetch, token: string, path: string) {
	const response = await fetchImpl(`${cloudflareApi}${path}`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
	if (!response.ok) throw new Error(`Cloudflare discovery failed (HTTP ${response.status}).`);
	const payload: any = await response.json(); if (payload.success === false) throw new Error('Cloudflare rejected hosted discovery.'); return payload.result;
}

async function railwayJson(fetchImpl: typeof fetch, token: string, query: string, variables: Record<string, unknown>) {
	const response = await fetchImpl(railwayApi, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
	if (!response.ok) throw new Error(`Railway discovery failed (HTTP ${response.status}).`);
	const payload: any = await response.json(); if (payload.errors?.length) throw new Error('Railway rejected hosted discovery.'); return payload.data;
}

async function discoverCloudflare(input: { resource: Resource; config: Record<string, string | number | boolean>; artifacts: HostedTopologyDeclaration['artifacts']; token: string; managed: boolean; fetchImpl: typeof fetch }): Promise<HostedResourceObservation> {
	const { resource, config, artifacts, token, fetchImpl } = input, context = { config, artifacts }, observedAt = new Date().toISOString(), desiredDigest = deploymentDigest(resource);
	if (resource.kind === 'pages-application') {
		const accountId = requiredInfrastructureString(config.accountId, 'accountId'), name = requiredInfrastructureString(parameter(resource, 'name', context), 'name');
		const response = await fetchImpl(`${cloudflareApi}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } });
		if (response.status === 404) return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
		if (!response.ok) throw new Error(`Cloudflare Pages discovery failed (HTTP ${response.status}).`);
		const payload: any = await response.json(); if (payload.success === false || !payload.result) throw new Error('Cloudflare rejected Pages discovery.');
		const project = payload.result, marker = project.deployment_configs?.production?.env_vars?.TREESEED_RESOURCE_DIGEST?.value;
		const matches = project.name === name && project.production_branch === String(parameter(resource, 'production-branch', context)) && project.build_config?.destination_dir === String(parameter(resource, 'destination-dir', context)) && marker === desiredDigest;
		return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: name, state: 'healthy', managedBy: marker || input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest({ name, productionBranch: project.production_branch ?? null, destinationDir: project.build_config?.destination_dir ?? null, marker: marker ?? null }), observedAt };
	}
	if (resource.kind === 'admin-application' || resource.kind === 'api-proxy') {
		const accountId = requiredInfrastructureString(config.accountId, 'accountId'), name = String(parameter(resource, 'name', context) ?? resource.id);
		const response = await fetchImpl(`${cloudflareApi}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } });
		if (response.status === 404) return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
		if (!response.ok) throw new Error(`Cloudflare Worker discovery failed (HTTP ${response.status}).`);
		const artifact = parameter(resource, 'artifact', context), expected = artifact && typeof artifact === 'object' && 'digest' in artifact ? String(artifact.digest) : '';
		const actual = `sha256:${createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')}`;
		return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: name, state: 'healthy', managedBy: input.managed ? 'treeseed' : 'external', observedDigest: actual === expected ? desiredDigest : deploymentDigest({ name, artifactDigest: actual }), observedAt };
	}
	const zoneId = requiredInfrastructureString(parameter(resource, 'zoneId', context) ?? config.zoneId, 'zoneId');
	if (resource.kind === 'dns-record') {
		const name = requiredInfrastructureString(parameter(resource, 'name', context), 'name'), type = String(parameter(resource, 'type', context) ?? 'CNAME');
		const records: any[] = await cloudflareJson(fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`), record = records[0];
		if (!record) return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
		const matches = record.type === type && record.name === name && record.content === String(parameter(resource, 'content', context)) && Boolean(record.proxied) === Boolean(parameter(resource, 'proxied', context) ?? true);
		return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: record.id, state: 'healthy', managedBy: String(record.comment ?? '').includes('treeseed:') || input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest(record), observedAt };
	}
	const setting: any = await cloudflareJson(fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/settings/ssl`), matches = setting.value === String(parameter(resource, 'mode', context));
	return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: `${zoneId}:ssl`, state: 'healthy', managedBy: input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest(setting), observedAt };
}

async function discoverRailway(input: { resource: Resource; config: Record<string, string | number | boolean>; artifacts: HostedTopologyDeclaration['artifacts']; token: string; managed: boolean; fetchImpl: typeof fetch }): Promise<HostedResourceObservation> {
	const { resource, config, artifacts, token, fetchImpl } = input, context = { config, artifacts }, observedAt = new Date().toISOString();
	const projectId = requiredInfrastructureString(config.projectId, 'projectId'), environmentId = requiredInfrastructureString(config.environmentId, 'environmentId'), name = String(parameter(resource, 'name', context) ?? resource.id);
	const data = await railwayJson(fetchImpl, token, `query TreeSeedHostedInventory($projectId: String!, $environmentId: String!) { project(id: $projectId) { services { edges { node { id name } } } } variables(projectId: $projectId, environmentId: $environmentId) }`, { projectId, environmentId });
	const service = (data.project?.services?.edges ?? []).map((edge: any) => edge.node).find((item: any) => item.name === name);
	if (!service) return { resourceId: resource.id, provider: 'railway', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
	const marker = data.variables?.[service.id]?.TREESEED_RESOURCE_DIGEST ?? data.variables?.[`TREESEED_RESOURCE_DIGEST_${resource.id.toUpperCase().replaceAll('-', '_')}`];
	return { resourceId: resource.id, provider: 'railway', kind: resource.kind, providerResourceId: service.id, state: 'healthy', managedBy: marker || input.managed ? 'treeseed' : 'external', observedDigest: marker === deploymentDigest(resource) ? marker : deploymentDigest({ serviceId: service.id, marker: marker ?? null }), observedAt };
}

export async function discoverHostedInfrastructure(input: { declaration: HostedTopologyDeclaration; stateBackend: unknown; connections: Connections; authority: HostedInfrastructureVaultAuthority; managedProviderResourceIds?: Iterable<string>; root: string; fetchImpl?: typeof fetch }) {
	const declaration = hostedTopologyDeclarationSchema.parse(input.declaration), requests = hostedInfrastructureDiscoveryRequests({ declaration, stateBackend: input.stateBackend });
	const synthetic = { environment: declaration.environment, authorities: requests } as HostedInfrastructureWorkspace;
	const environment = hostedInfrastructureAuthorityEnvironment(synthetic, input.authority, input.root), managed = new Set(input.managedProviderResourceIds ?? []), fetchImpl = input.fetchImpl ?? fetch;
	const observations: HostedResourceObservation[] = [];
	for (const resource of declaration.resources) {
		const connection = input.connections[resource.provider], binding = declaration.providerConnections[resource.provider];
		if (!connection || !binding || connection.connectionRef !== binding.connectionRef) throw new Error(`Hosted discovery ${resource.provider} connection is unavailable.`);
		const selected = profile(resource.provider, resource.kind), token = environment[resource.provider === 'railway' ? 'RAILWAY_TOKEN' : selected.credentialProfileId === 'cloudflare-dns' ? 'TF_VAR_cloudflare_dns_token' : 'TF_VAR_cloudflare_runtime_token'];
		if (!token) throw new Error(`Hosted discovery ${selected.credentialProfileId} authority is unavailable.`);
		const common = { resource, config: connection.nonSecretConfig, artifacts: declaration.artifacts, token, managed: false, fetchImpl };
		const observation = resource.provider === 'cloudflare' ? await discoverCloudflare(common) : await discoverRailway(common);
		if (observation.providerResourceId && managed.has(observation.providerResourceId)) observation.managedBy = 'treeseed'; observations.push(observation);
	}
	return observations.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}
