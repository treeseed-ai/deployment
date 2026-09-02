import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeHostedTopologyPlan, hostedTopologyDeclarationSchema, planHostedTopology, type HostedResourceObservation } from '@treeseed/sdk/deployment';
import { HostedInfrastructureExecutor, hostedInfrastructureToolchain, renderHostedInfrastructureWorkspace, type OpenTofuCommand } from '../src/infrastructure/opentofu/index.js';

const workerSource = 'export default { fetch() { return new Response("ok") } };\n';
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = '2026-09-02T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function topology() {
	return hostedTopologyDeclarationSchema.parse({
		schemaVersion: 'treeseed.hosted-topology/v1', id: 'tree-production', environment: 'production', mutation: 'approval-required',
		platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) },
		providerConnections: { cloudflare: { connectionRef: 'cloudflare-production' }, railway: { connectionRef: 'railway-production' } },
		artifacts: {
			admin: { digest: digest(workerSource), source: 'https://artifacts.example.test/admin.mjs' },
			api: { digest: `sha256:${'b'.repeat(64)}`, source: 'https://ghcr.example.test/treeseed/api@sha256:bbbb' },
		},
		resources: [
			{ id: 'admin', provider: 'cloudflare', kind: 'admin-application', dependsOn: ['api'], parameters: { name: { literal: 'treeseed-admin' }, artifact: { artifact: 'admin' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'admin-dns', provider: 'cloudflare', kind: 'dns-record', dependsOn: ['admin'], parameters: { name: { literal: 'admin.example.test' }, type: { literal: 'CNAME' }, content: { literal: 'treeseed-admin.workers.dev' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'admin-tls', provider: 'cloudflare', kind: 'tls-policy', dependsOn: ['admin-dns'], parameters: { mode: { literal: 'strict' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'api', provider: 'railway', kind: 'control-plane-api', dependsOn: ['postgres'], parameters: { name: { literal: 'production-api' }, artifact: { artifact: 'api' }, 'healthcheck-path': { literal: '/health' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'postgres', provider: 'railway', kind: 'postgresql', dependsOn: [], parameters: { name: { literal: 'production-postgres' }, 'volume-name': { literal: 'postgres-data' }, 'volume-mount-path': { literal: '/var/lib/postgresql/data' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
		],
	});
}

function connections() {
	return {
		cloudflare: { connectionRef: 'cloudflare-production', nonSecretConfig: { accountId: 'cf-account', zoneId: 'cf-zone' } },
		railway: { connectionRef: 'railway-production', nonSecretConfig: { workspaceId: 'rw-workspace', projectId: 'rw-project', environmentId: 'rw-environment', environmentName: 'production' } },
	};
}

function plan(observations: HostedResourceObservation[] = []) { return planHostedTopology({ declaration: topology(), observations, connections: connections() }); }
function approved(input = plan()) { return authorizeHostedTopologyPlan(input, { schemaVersion: 'treeseed.hosted-topology-approval/v1', planDigest: input.planDigest, environment: 'production', decision: 'approved', approvedBy: 'release-approver', approvedAt: now }); }
const backend = { type: 's3' as const, bucket: 'treeseed-infrastructure-state', key: 'production/topology.tfstate', region: 'auto', endpoint: 'https://r2.example.test', usePathStyle: true };

describe('Deployment-owned OpenTofu hosted infrastructure', () => {
	it('locks the exact OpenTofu and provider supply chain', async () => {
		expect(hostedInfrastructureToolchain.opentofu.version).toBe('1.12.6');
		expect(hostedInfrastructureToolchain.providers.cloudflare).toEqual({ source: 'registry.opentofu.org/cloudflare/cloudflare', version: '5.24.0' });
		expect(hostedInfrastructureToolchain.providers.railway.source).toBe('registry.opentofu.org/jamesprnich/railway');
		const lock = await readFile(new URL('../infrastructure/opentofu/hosted-topology/.terraform.lock.hcl', import.meta.url), 'utf8');
		expect(lock).toContain('registry.opentofu.org/cloudflare/cloudflare'); expect(lock).toContain('registry.opentofu.org/jamesprnich/railway'); expect(lock).toContain('0.11.5');
	});

	it('renders a deterministic, portable, credential-free workspace', () => {
		const first = renderHostedInfrastructureWorkspace({ plan: plan(), backend }), second = renderHostedInfrastructureWorkspace({ plan: plan(), backend });
		expect(second.bundleDigest).toBe(first.bundleDigest); expect(first.executable).toBe(false);
		expect(Object.keys(first.files)).toEqual(expect.arrayContaining(['versions.tf', 'main.tf', '.terraform.lock.hcl', 'backend.tf.json', 'terraform.tfvars.json']));
		const rendered = Object.values(first.files).join('\n');
		expect(rendered).toContain('cloudflare_workers_script'); expect(rendered).toContain('railway_service_instance'); expect(rendered).toContain('railway_variable');
		expect(rendered).not.toMatch(/super-secret|apiToken|RAILWAY_TOKEN|CLOUDFLARE_API_TOKEN/u);
		expect(first.artifacts).toEqual([{ id: 'admin', source: 'https://artifacts.example.test/admin.mjs', digest: digest(workerSource), path: 'artifacts/admin' }]);
		expect(renderHostedInfrastructureWorkspace({ plan: approved(), backend }).executable).toBe(true);
	});

	it('renders imports for reviewed existing resources without replacement', () => {
		const declaration = topology(), observations = declaration.resources.map((resource): HostedResourceObservation => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: `${resource.id}-provider-id`, state: 'healthy', managedBy: 'treeseed', observedDigest: null, observedAt: now }));
		const workspace = renderHostedInfrastructureWorkspace({ plan: approved(plan(observations)), backend });
		expect(workspace.imports).toContainEqual({ address: 'cloudflare_workers_script.managed["admin"]', id: 'cf-account/treeseed-admin' });
		expect(workspace.imports).toContainEqual({ address: 'cloudflare_dns_record.managed["admin-dns"]', id: 'cf-zone/admin-dns-provider-id' });
		expect(workspace.imports).toContainEqual({ address: 'railway_service.managed["api"]', id: 'api-provider-id:rw-environment' });
		expect(workspace.imports).toContainEqual({ address: 'railway_variable.managed["api:TREESEED_RESOURCE_DIGEST"]', id: 'api-provider-id:production:TREESEED_RESOURCE_DIGEST' });
		expect(workspace.files['main.tf']).toContain('prevent_destroy = true');
	});

	it('plans and applies only the exact authorized binary plan', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-')); roots.push(root);
		const calls: string[][] = [];
		const command: OpenTofuCommand = async (args, options) => {
			calls.push(args);
			if (args[0] === 'version') return { code: 0, stdout: JSON.stringify({ terraform_version: '1.12.6' }), stderr: '' };
			if (args[0] === 'plan') { await writeFile(join(options.cwd, 'treeseed.plan'), 'immutable-binary-plan'); return { code: 2, stdout: '', stderr: '' }; }
			return { code: 0, stdout: '', stderr: '' };
		};
		const executor = new HostedInfrastructureExecutor(command, async () => new Response(workerSource));
		const unauthorized = renderHostedInfrastructureWorkspace({ plan: plan(), backend });
		const result = await executor.plan(unauthorized, root, { PATH: process.env.PATH, RAILWAY_TOKEN: 'super-secret' });
		await expect(executor.apply(unauthorized, root, {}, result.executionPlanDigest)).rejects.toThrow(/authorized executable/u);
		const authorized = renderHostedInfrastructureWorkspace({ plan: approved(), backend });
		await executor.prepare(authorized, root);
		await expect(executor.apply(authorized, root, {}, `sha256:${'f'.repeat(64)}`)).rejects.toThrow(/approved digest/u);
		expect((await executor.apply(authorized, root, {}, result.executionPlanDigest)).applied).toBe(true);
		expect(calls.some((args) => args[0] === 'init')).toBe(true); expect(calls.some((args) => args[0] === 'apply')).toBe(true);
	});

	it('redacts provider authority from failures', async () => {
		const executor = new HostedInfrastructureExecutor(async () => ({ code: 1, stdout: '', stderr: 'provider rejected super-secret' }));
		await expect(executor.verifyVersion('/tmp', { RAILWAY_TOKEN: 'super-secret' })).rejects.not.toThrow(/super-secret/u);
	});
});
