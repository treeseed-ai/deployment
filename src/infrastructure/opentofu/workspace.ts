import { authorizedHostedTopologyPlanSchema, hostedTopologyPlanSchema, type AuthorizedHostedTopologyPlan, type HostedStateBackend, type HostedTopologyPlan } from '@treeseed/sdk/deployment';
import { infrastructureDigest, hostedInfrastructureToolchain } from './toolchain.js';
import { requiredInfrastructureString, resolveHostedInfrastructureParameter } from './parameters.js';
import { hostedInfrastructureModuleFiles } from './module.js';
import type { HostedInfrastructureAuthorityRequest, HostedInfrastructureCredentialProfile, HostedInfrastructureEnvironment } from './authority.js';

type Action = HostedTopologyPlan['actions'][number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface HostedInfrastructureArtifactRequest {
	id: string;
	source: string;
	digest: string;
	path: string;
}

export interface HostedInfrastructureImport {
	address: string;
	id: string;
}

export interface HostedInfrastructureWorkspace {
	schemaVersion: 'treeseed.hosted-infrastructure-workspace/v1';
	planDigest: string;
	teamId: string;
	deploymentId: string;
	stackId: string;
	environment: HostedInfrastructureEnvironment;
	stateBackend: HostedStateBackend;
	executable: boolean;
	bundleDigest: string;
	toolchain: typeof hostedInfrastructureToolchain;
	files: Record<string, string>;
	artifacts: HostedInfrastructureArtifactRequest[];
	pagesDeployments: Array<{ resourceId: string; accountId: string; projectName: string; branch: string; artifactPath: string; destinationDirectory: string; commit: string; marker: string; changed: boolean }>;
	imports: HostedInfrastructureImport[];
	authorities: HostedInfrastructureAuthorityRequest[];
	resources: Array<{ resourceId: string; provider: Action['provider']; kind: Action['kind']; desiredDigest: string; output: 'cloudflare_pages' | 'cloudflare_workers' | 'cloudflare_dns_records' | 'cloudflare_tls_policies' | 'railway_services' }>;
	removedResources: Array<{ resourceId: string; provider: Action['provider']; kind: Action['kind'] }>;
}

function authorityProfile(provider: 'cloudflare' | 'railway', kind: Action['kind']): { credentialProfileId: HostedInfrastructureCredentialProfile; capability: string } {
	if (provider === 'railway') return { credentialProfileId: 'railway-workspace', capability: kind === 'postgresql' ? 'database-hosting' : kind === 'treedx-service' ? 'private-knowledge-index-hosting' : 'backend-hosting' };
	return ['dns-record', 'tls-policy'].includes(kind) ? { credentialProfileId: 'cloudflare-dns', capability: 'dns-management' } : { credentialProfileId: 'cloudflare-runtime', capability: 'frontend-hosting' };
}

function parameter(action: Action, name: string, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	return resolveHostedInfrastructureParameter(action.desiredResource.parameters[name], context);
}

function resourceName(action: Action, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	return String(parameter(action, 'name', context) ?? action.resourceId);
}

function railwayVariable(action: Action, name: string, plan: HostedTopologyPlan | AuthorizedHostedTopologyPlan, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	const binding = action.desiredResource.parameters[`variable.${name}`];
	if (!binding || !('resourceOutput' in binding)) return String(parameter(action, `variable.${name}`, context));
	const reference = binding.resourceOutput, target = plan.actions.find(({ resourceId }) => resourceId === reference.resourceId);
	if (!target || target.provider !== 'railway' || !action.desiredResource.dependsOn.includes(target.resourceId)) throw new Error(`Railway variable ${name} requires a depended-on Railway resource.`);
	const targetConnection = plan.providerConnections.railway;
	if (!targetConnection) throw new Error('Railway resource output requires a Railway connection.');
	const targetName = resourceName(target, { config: targetConnection.nonSecretConfig, artifacts: plan.artifacts });
	if (reference.output === 'database-url' && target.kind === 'postgresql') return `\${{${targetName}.DATABASE_URL}}`;
	if (reference.output === 'private-url' && target.kind !== 'postgresql') return `http://\${{${targetName}.RAILWAY_PRIVATE_DOMAIN}}`;
	throw new Error(`Railway resource output ${target.resourceId}.${reference.output} is unsupported.`);
}

function importEntries(action: Action, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]): HostedInfrastructureImport[] {
	if (!action.providerResourceId) return [];
	if (action.provider === 'cloudflare') {
		if (action.kind === 'dns-record') {
			const zoneId = requiredInfrastructureString(parameter(action, 'zoneId', context) ?? context.config.zoneId, 'zoneId');
			return [{ address: `cloudflare_dns_record.managed[\"${action.resourceId}\"]`, id: `${zoneId}/${action.providerResourceId}` }];
		}
		if (action.kind === 'tls-policy') {
			const zoneId = requiredInfrastructureString(parameter(action, 'zoneId', context) ?? context.config.zoneId, 'zoneId');
			return [{ address: `cloudflare_zone_setting.managed[\"${action.resourceId}\"]`, id: `${zoneId}/ssl` }];
		}
		const accountId = requiredInfrastructureString(context.config.accountId, 'accountId');
		if (action.kind === 'pages-application') return [{ address: `cloudflare_pages_project.managed[\"${action.resourceId}\"]`, id: `${accountId}/${resourceName(action, context)}` }];
		return [{ address: `cloudflare_workers_script.managed[\"${action.resourceId}\"]`, id: `${accountId}/${resourceName(action, context)}` }];
	}
	const environmentId = requiredInfrastructureString(context.config.environmentId, 'environmentId');
	const environmentName = requiredInfrastructureString(context.config.environmentName, 'environmentName');
	const variables = ['TREESEED_RESOURCE_DIGEST', ...Object.keys(action.desiredResource.parameters).filter((key) => key.startsWith('variable.')).map((key) => key.slice(9))];
	return [
		{ address: `railway_service.managed[\"${action.resourceId}\"]`, id: `${action.providerResourceId}:${environmentId}` },
		{ address: `railway_service_instance.managed[\"${action.resourceId}\"]`, id: `${action.providerResourceId}:${environmentId}` },
		...variables.map((name) => ({ address: `railway_variable.managed[\"${action.resourceId}:${name}\"]`, id: `${action.providerResourceId}:${environmentName}:${name}` })),
	];
}

function renderVariables(plan: HostedTopologyPlan | AuthorizedHostedTopologyPlan) {
	const cloudflarePages: Record<string, Json> = {}, cloudflareWorkers: Record<string, Json> = {}, cloudflareDns: Record<string, Json> = {}, cloudflareTls: Record<string, Json> = {};
	const railwayServices: Record<string, Json> = {}, artifacts: HostedInfrastructureArtifactRequest[] = [], pagesDeployments: HostedInfrastructureWorkspace['pagesDeployments'] = [], imports: HostedInfrastructureImport[] = [], resources: HostedInfrastructureWorkspace['resources'] = [], authorityMap = new Map<string, HostedInfrastructureAuthorityRequest>();
	for (const action of plan.actions) {
		const connection = plan.providerConnections[action.provider];
		if (!connection) throw new Error(`Hosted infrastructure plan is missing its ${action.provider} connection.`);
		const context = { config: connection.nonSecretConfig, artifacts: plan.artifacts };
		if (context.config.deploymentEnvironment !== plan.environment) throw new Error(`${action.provider} connection ${connection.connectionRef} is not bound to the ${plan.environment} deployment environment.`);
		const selected = authorityProfile(action.provider, action.kind), requestId = `${connection.connectionRef}:${selected.credentialProfileId}`;
		const existing = authorityMap.get(requestId);
		if (existing) existing.capabilities = [...new Set([...existing.capabilities, selected.capability])].sort();
		else authorityMap.set(requestId, { requestId, teamId: plan.teamId, deploymentId: plan.deploymentId, stackId: plan.stackId, environment: plan.environment, backendBindingDigest: plan.stateBackend!.bindingDigest, provider: action.provider, connectionRef: connection.connectionRef, credentialProfileId: selected.credentialProfileId, capabilities: [selected.capability], purpose: 'provider' });
		imports.push(...importEntries(action, context));
		resources.push({ resourceId: action.resourceId, provider: action.provider, kind: action.kind, desiredDigest: action.desiredDigest,
			output: action.provider === 'railway' ? 'railway_services' : action.kind === 'pages-application' ? 'cloudflare_pages' : action.kind === 'dns-record' ? 'cloudflare_dns_records' : action.kind === 'tls-policy' ? 'cloudflare_tls_policies' : 'cloudflare_workers' });
		if (action.provider === 'cloudflare') {
			const zoneId = parameter(action, 'zoneId', context) ?? context.config.zoneId;
			if (action.kind === 'pages-application') {
				const artifact = parameter(action, 'artifact', context);
				if (!artifact || typeof artifact !== 'object' || !('source' in artifact) || !('digest' in artifact) || !('id' in artifact) || !('kind' in artifact) || artifact.kind !== 'archive' || !('format' in artifact) || artifact.format !== 'tar+gzip') throw new Error(`Cloudflare Pages application ${action.resourceId} requires a tar+gzip archive artifact.`);
				if (parameter(action, 'artifact-format', context) !== 'tar+gzip') throw new Error(`Cloudflare Pages application ${action.resourceId} requires a tar+gzip artifact.`);
				const path = `artifacts/${String(artifact.id)}.tgz`;
				artifacts.push({ id: String(artifact.id), source: String(artifact.source), digest: String(artifact.digest), path });
				const accountId = requiredInfrastructureString(context.config.accountId, 'accountId'), name = resourceName(action, context), branch = requiredInfrastructureString(parameter(action, 'production-branch', context), 'production-branch'), destinationDirectory = requiredInfrastructureString(parameter(action, 'destination-dir', context), 'destination-dir');
				cloudflarePages[action.resourceId] = { account_id: accountId, name, production_branch: branch, destination_dir: destinationDirectory, artifact_sha256: String(artifact.digest).replace(/^sha256:/u, ''), desired_digest: action.desiredDigest };
				pagesDeployments.push({ resourceId: action.resourceId, accountId, projectName: name, branch, artifactPath: path, destinationDirectory, commit: plan.platformCommit, marker: `treeseed:${action.desiredDigest}:${String(artifact.digest)}`, changed: action.action !== 'noop' });
			} else if (action.kind === 'admin-application' || action.kind === 'api-proxy') {
				const artifact = parameter(action, 'artifact', context);
				if (!artifact || typeof artifact !== 'object' || !('source' in artifact) || !('digest' in artifact) || !('id' in artifact) || !('kind' in artifact) || artifact.kind !== 'file') throw new Error(`Cloudflare worker ${action.resourceId} requires a file artifact.`);
				const path = `artifacts/${String(artifact.id)}`;
				artifacts.push({ id: String(artifact.id), source: String(artifact.source), digest: String(artifact.digest), path });
				const plainTextBindings = Object.fromEntries(Object.keys(action.desiredResource.parameters).filter((key) => key.startsWith('variable.')).sort().map((key) => [key.slice(9), String(parameter(action, key, context))]));
				cloudflareWorkers[action.resourceId] = { account_id: requiredInfrastructureString(context.config.accountId, 'accountId'), script_name: resourceName(action, context), content_file: path, content_sha256: String(artifact.digest).replace(/^sha256:/u, ''), compatibility_date: String(parameter(action, 'compatibility-date', context) ?? '2026-08-01'), plain_text_bindings: plainTextBindings, desired_digest: action.desiredDigest };
			} else if (action.kind === 'dns-record') {
				cloudflareDns[action.resourceId] = { zone_id: requiredInfrastructureString(zoneId, 'zoneId'), name: requiredInfrastructureString(parameter(action, 'name', context), 'name'), type: String(parameter(action, 'type', context) ?? 'CNAME'), content: requiredInfrastructureString(parameter(action, 'content', context), 'content'), ttl: Number(parameter(action, 'ttl', context) ?? 1), proxied: Boolean(parameter(action, 'proxied', context) ?? true), desired_digest: action.desiredDigest };
			} else {
				cloudflareTls[action.resourceId] = { zone_id: requiredInfrastructureString(zoneId, 'zoneId'), mode: requiredInfrastructureString(parameter(action, 'mode', context), 'mode'), desired_digest: action.desiredDigest };
			}
			continue;
		}
		const projectId = requiredInfrastructureString(context.config.projectId, 'projectId'), environmentId = requiredInfrastructureString(context.config.environmentId, 'environmentId');
		const artifact = parameter(action, 'artifact', context);
		const sourceImage = artifact && typeof artifact === 'object' && 'kind' in artifact && artifact.kind === 'oci-image' && 'identity' in artifact
			? String(artifact.identity) : requiredInfrastructureString(parameter(action, 'image', context), 'image');
		if (!/@sha256:[a-f0-9]{64}$/u.test(sourceImage)) throw new Error(`Railway service ${action.resourceId} requires an immutable OCI image identity.`);
		const variables: Record<string, string> = { TREESEED_RESOURCE_DIGEST: action.desiredDigest };
		for (const key of Object.keys(action.desiredResource.parameters).sort()) if (key.startsWith('variable.')) variables[key.slice(9)] = railwayVariable(action, key.slice(9), plan, context);
		railwayServices[action.resourceId] = { project_id: projectId, environment_id: environmentId, environment_name: requiredInfrastructureString(context.config.environmentName, 'environmentName'), name: resourceName(action, context), source_image: sourceImage, healthcheck_path: parameter(action, 'healthcheck-path', context) ?? null, start_command: parameter(action, 'start-command', context) ?? null, num_replicas: Number(parameter(action, 'replicas', context) ?? 1), vcpus: Number(parameter(action, 'vcpus', context) ?? 1), memory_gb: Number(parameter(action, 'memory-gb', context) ?? 1), volume_name: parameter(action, 'volume-name', context) ?? null, volume_mount_path: parameter(action, 'volume-mount-path', context) ?? null, variables, desired_digest: action.desiredDigest };
	}
	return { variables: { cloudflare_pages: cloudflarePages, cloudflare_workers: cloudflareWorkers, cloudflare_dns_records: cloudflareDns, cloudflare_tls_policies: cloudflareTls, railway_services: railwayServices }, artifacts: [...new Map(artifacts.map((item) => [item.id, item])).values()].sort((left, right) => left.id.localeCompare(right.id)), pagesDeployments: pagesDeployments.sort((left, right) => left.resourceId.localeCompare(right.resourceId)), imports: imports.sort((left, right) => left.address.localeCompare(right.address)), resources: resources.sort((left, right) => left.resourceId.localeCompare(right.resourceId)), authorities: [...authorityMap.values()].sort((left, right) => left.requestId.localeCompare(right.requestId)) };
}

function backendConfiguration(backend: HostedStateBackend): Json {
	return { terraform: { backend: { s3: { bucket: backend.bucket, key: backend.key, region: backend.region, ...(backend.endpoint ? { endpoints: { s3: backend.endpoint }, skip_credentials_validation: true, skip_region_validation: true, skip_requesting_account_id: true, skip_metadata_api_check: true } : {}), ...(backend.usePathStyle === undefined ? {} : { use_path_style: backend.usePathStyle }), encrypt: true, use_lockfile: true } } } };
}

export function renderHostedInfrastructureWorkspace(input: { plan: HostedTopologyPlan | AuthorizedHostedTopologyPlan }): HostedInfrastructureWorkspace {
	const plan = input.plan.executable === true ? authorizedHostedTopologyPlanSchema.parse(input.plan) : hostedTopologyPlanSchema.parse(input.plan);
	if (plan.blockers.length) throw new Error('Hosted infrastructure plan has unresolved blockers.');
	if (!plan.stateBackend) throw new Error('Hosted infrastructure plan has no state backend authority.');
	const rendered = renderVariables(plan);
	const custody = { teamId: plan.teamId, deploymentId: plan.deploymentId, stackId: plan.stackId, environment: plan.environment, backendBindingDigest: plan.stateBackend.bindingDigest };
	const backendRequest: HostedInfrastructureAuthorityRequest = { requestId: `state-backend:${plan.stateBackend.bindingDigest}`, ...custody, provider: 'treeseed', connectionRef: plan.stateBackend.connectionRef, credentialProfileId: 's3-state-session', capabilities: ['object-storage'], purpose: 'state-backend' };
	const encryptionRequest: HostedInfrastructureAuthorityRequest = { requestId: `state-encryption:${plan.stateBackend.bindingDigest}`, ...custody, provider: 'treeseed', connectionRef: plan.stateBackend.connectionRef, secretRef: plan.stateBackend.encryptionKeyRef, credentialProfileId: 'opentofu-state-encryption', capabilities: ['state-encryption'], purpose: 'state-encryption' };
	const authorities = [...rendered.authorities, backendRequest, encryptionRequest].reduce((map, request) => {
		const existing = map.get(request.requestId);
		if (existing && existing.purpose !== request.purpose) throw new Error(`Hosted infrastructure authority ${request.requestId} cannot serve provider and state-backend purposes together.`);
		map.set(request.requestId, request); return map;
	}, new Map<string, HostedInfrastructureAuthorityRequest>());
	const files = {
		...hostedInfrastructureModuleFiles(),
		'backend.tf.json': `${JSON.stringify(backendConfiguration(plan.stateBackend), null, 2)}\n`,
		'encryption.tf.json': `${JSON.stringify({ terraform: { encryption: { state: { enforced: true }, plan: { enforced: true } } } }, null, 2)}\n`,
		'terraform.tfvars.json': `${JSON.stringify(rendered.variables, null, 2)}\n`,
	};
	const core = { planDigest: plan.planDigest, teamId: plan.teamId, deploymentId: plan.deploymentId, stackId: plan.stackId, environment: plan.environment, stateBackend: plan.stateBackend, executable: plan.executable, toolchain: hostedInfrastructureToolchain, files, artifacts: rendered.artifacts, pagesDeployments: rendered.pagesDeployments, imports: rendered.imports, resources: rendered.resources, removedResources: [], authorities: [...authorities.values()].sort((left, right) => left.requestId.localeCompare(right.requestId)) };
	return { schemaVersion: 'treeseed.hosted-infrastructure-workspace/v1', ...core, bundleDigest: infrastructureDigest(core) };
}
