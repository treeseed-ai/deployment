import { authorizedHostedTopologyPlanSchema, hostedTopologyPlanSchema, type AuthorizedHostedTopologyPlan, type HostedTopologyPlan } from '@treeseed/sdk/deployment';
import { infrastructureDigest, hostedInfrastructureToolchain } from './toolchain.js';
import { requiredInfrastructureString, resolveHostedInfrastructureParameter } from './parameters.js';
import { hostedInfrastructureModuleFiles } from './module.js';

type Action = HostedTopologyPlan['actions'][number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface HostedInfrastructureBackend {
	type: 's3';
	bucket: string;
	key: string;
	region: string;
	endpoint?: string;
	usePathStyle?: boolean;
}

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
	executable: boolean;
	bundleDigest: string;
	toolchain: typeof hostedInfrastructureToolchain;
	files: Record<string, string>;
	artifacts: HostedInfrastructureArtifactRequest[];
	imports: HostedInfrastructureImport[];
}

function parameter(action: Action, name: string, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	return resolveHostedInfrastructureParameter(action.desiredResource.parameters[name], context);
}

function resourceName(action: Action, context: Parameters<typeof resolveHostedInfrastructureParameter>[1]) {
	return String(parameter(action, 'name', context) ?? action.resourceId);
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
	const cloudflareWorkers: Record<string, Json> = {}, cloudflareDns: Record<string, Json> = {}, cloudflareTls: Record<string, Json> = {};
	const railwayServices: Record<string, Json> = {}, artifacts: HostedInfrastructureArtifactRequest[] = [], imports: HostedInfrastructureImport[] = [];
	for (const action of plan.actions) {
		const connection = plan.providerConnections[action.provider];
		if (!connection) throw new Error(`Hosted infrastructure plan is missing its ${action.provider} connection.`);
		const context = { config: connection.nonSecretConfig, artifacts: plan.artifacts };
		imports.push(...importEntries(action, context));
		if (action.provider === 'cloudflare') {
			const zoneId = parameter(action, 'zoneId', context) ?? context.config.zoneId;
			if (action.kind === 'admin-application' || action.kind === 'api-proxy') {
				const artifact = parameter(action, 'artifact', context);
				if (!artifact || typeof artifact !== 'object' || !('source' in artifact) || !('digest' in artifact) || !('id' in artifact)) throw new Error(`Cloudflare worker ${action.resourceId} requires an artifact.`);
				const path = `artifacts/${String(artifact.id)}`;
				artifacts.push({ id: String(artifact.id), source: String(artifact.source), digest: String(artifact.digest), path });
				cloudflareWorkers[action.resourceId] = { account_id: requiredInfrastructureString(context.config.accountId, 'accountId'), script_name: resourceName(action, context), content_file: path, content_sha256: String(artifact.digest).replace(/^sha256:/u, ''), compatibility_date: String(parameter(action, 'compatibility-date', context) ?? '2026-08-01'), desired_digest: action.desiredDigest };
			} else if (action.kind === 'dns-record') {
				cloudflareDns[action.resourceId] = { zone_id: requiredInfrastructureString(zoneId, 'zoneId'), name: requiredInfrastructureString(parameter(action, 'name', context), 'name'), type: String(parameter(action, 'type', context) ?? 'CNAME'), content: requiredInfrastructureString(parameter(action, 'content', context), 'content'), ttl: Number(parameter(action, 'ttl', context) ?? 1), proxied: Boolean(parameter(action, 'proxied', context) ?? true), desired_digest: action.desiredDigest };
			} else {
				cloudflareTls[action.resourceId] = { zone_id: requiredInfrastructureString(zoneId, 'zoneId'), mode: requiredInfrastructureString(parameter(action, 'mode', context), 'mode'), desired_digest: action.desiredDigest };
			}
			continue;
		}
		const projectId = requiredInfrastructureString(context.config.projectId, 'projectId'), environmentId = requiredInfrastructureString(context.config.environmentId, 'environmentId');
		const artifact = parameter(action, 'artifact', context), sourceImage = action.kind === 'postgresql' ? String(parameter(action, 'image', context) ?? 'postgres:17') : artifact && typeof artifact === 'object' && 'source' in artifact ? String(artifact.source) : requiredInfrastructureString(parameter(action, 'image', context), 'image');
		const variables: Record<string, string> = { TREESEED_RESOURCE_DIGEST: action.desiredDigest };
		for (const key of Object.keys(action.desiredResource.parameters).sort()) if (key.startsWith('variable.')) variables[key.slice(9)] = String(parameter(action, key, context));
		railwayServices[action.resourceId] = { project_id: projectId, environment_id: environmentId, environment_name: requiredInfrastructureString(context.config.environmentName, 'environmentName'), name: resourceName(action, context), source_image: sourceImage, healthcheck_path: parameter(action, 'healthcheck-path', context) ?? null, start_command: parameter(action, 'start-command', context) ?? null, num_replicas: Number(parameter(action, 'replicas', context) ?? 1), vcpus: Number(parameter(action, 'vcpus', context) ?? 1), memory_gb: Number(parameter(action, 'memory-gb', context) ?? 1), volume_name: parameter(action, 'volume-name', context) ?? null, volume_mount_path: parameter(action, 'volume-mount-path', context) ?? null, variables, desired_digest: action.desiredDigest };
	}
	return { variables: { cloudflare_workers: cloudflareWorkers, cloudflare_dns_records: cloudflareDns, cloudflare_tls_policies: cloudflareTls, railway_services: railwayServices }, artifacts: [...new Map(artifacts.map((item) => [item.id, item])).values()].sort((left, right) => left.id.localeCompare(right.id)), imports: imports.sort((left, right) => left.address.localeCompare(right.address)) };
}

function backendConfiguration(backend: HostedInfrastructureBackend): Json {
	if (!backend.bucket.trim() || !backend.key.trim() || !backend.region.trim()) throw new Error('Hosted infrastructure state backend requires bucket, key, and region.');
	return { terraform: { backend: { s3: { bucket: backend.bucket, key: backend.key, region: backend.region, ...(backend.endpoint ? { endpoints: { s3: backend.endpoint } } : {}), ...(backend.usePathStyle === undefined ? {} : { use_path_style: backend.usePathStyle }), encrypt: true } } } };
}

export function renderHostedInfrastructureWorkspace(input: { plan: HostedTopologyPlan | AuthorizedHostedTopologyPlan; backend: HostedInfrastructureBackend }): HostedInfrastructureWorkspace {
	const plan = 'approval' in input.plan ? authorizedHostedTopologyPlanSchema.parse(input.plan) : hostedTopologyPlanSchema.parse(input.plan);
	if (plan.blockers.length) throw new Error('Hosted infrastructure plan has unresolved blockers.');
	const rendered = renderVariables(plan);
	const files = {
		...hostedInfrastructureModuleFiles(),
		'backend.tf.json': `${JSON.stringify(backendConfiguration(input.backend), null, 2)}\n`,
		'terraform.tfvars.json': `${JSON.stringify(rendered.variables, null, 2)}\n`,
	};
	const core = { planDigest: plan.planDigest, executable: plan.executable, toolchain: hostedInfrastructureToolchain, files, artifacts: rendered.artifacts, imports: rendered.imports };
	return { schemaVersion: 'treeseed.hosted-infrastructure-workspace/v1', ...core, bundleDigest: infrastructureDigest(core) };
}
