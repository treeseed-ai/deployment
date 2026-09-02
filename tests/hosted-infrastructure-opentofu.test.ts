import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeHostedTopologyPlan, bindHostedStateBackend, hostedTopologyDeclarationSchema, hostedTopologyStateKey, planHostedTopology, planHostedTopologyRollback, planHostedTopologyRollbackExecution, verifyHostedTopologyReadback, type HostedResourceObservation } from '@treeseed/sdk/deployment';
import { acquireOpenTofu, discoverHostedInfrastructure, HostedInfrastructureExecutor, hostedInfrastructureDiscoveryRequests, hostedInfrastructureToolchain, openTofuArchive, renderHostedInfrastructureRollbackWorkspace, renderHostedInfrastructureWorkspace, resolveHostedInfrastructureVaultAuthority, type HostedInfrastructureAuthorityRequest, type OpenTofuCommand } from '../src/infrastructure/opentofu/index.js';

const workerSource = 'export default { fetch() { return new Response("ok") } };\n';
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = '2026-09-02T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function topology() {
	return hostedTopologyDeclarationSchema.parse({
		schemaVersion: 'treeseed.hosted-topology/v1', id: 'tree-production', teamId: 'team-treeseed', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'production', mutation: 'approval-required',
		platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) },
		stateBackend: { connectionRef: 'cloudflare-state' },
		providerConnections: { cloudflare: { connectionRef: 'cloudflare-production' }, railway: { connectionRef: 'railway-production' } },
		artifacts: {
			admin: { digest: digest(workerSource), source: 'https://artifacts.example.test/admin.mjs' },
			api: { digest: `sha256:${'b'.repeat(64)}`, source: 'https://ghcr.example.test/treeseed/api@sha256:bbbb' },
		},
		resources: [
			{ id: 'admin', provider: 'cloudflare', kind: 'pages-application', dependsOn: ['api'], parameters: { name: { literal: 'treeseed-admin' }, artifact: { artifact: 'admin' }, 'production-branch': { literal: 'main' }, 'destination-dir': { literal: '.treeseed/app-dist' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'admin-dns', provider: 'cloudflare', kind: 'dns-record', dependsOn: ['admin'], parameters: { name: { literal: 'admin.example.test' }, type: { literal: 'CNAME' }, content: { literal: 'treeseed-admin.pages.dev' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'admin-tls', provider: 'cloudflare', kind: 'tls-policy', dependsOn: ['admin-dns'], parameters: { mode: { literal: 'strict' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'api', provider: 'railway', kind: 'control-plane-api', dependsOn: ['postgres'], parameters: { name: { literal: 'production-api' }, artifact: { artifact: 'api' }, 'healthcheck-path': { literal: '/health' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
			{ id: 'postgres', provider: 'railway', kind: 'postgresql', dependsOn: [], parameters: { name: { literal: 'production-postgres' }, 'volume-name': { literal: 'postgres-data' }, 'volume-mount-path': { literal: '/var/lib/postgresql/data' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
		],
	});
}

function connections() {
	return {
		cloudflare: { connectionRef: 'cloudflare-production', nonSecretConfig: { deploymentEnvironment: 'production', accountId: 'cf-account', zoneId: 'cf-zone' } },
		railway: { connectionRef: 'railway-production', nonSecretConfig: { deploymentEnvironment: 'production', workspaceId: 'rw-workspace', projectId: 'rw-project', environmentId: 'rw-environment', environmentName: 'production' } },
	};
}

const backend = bindHostedStateBackend({ schemaVersion: 'treeseed.hosted-state-backend/v1', type: 's3', teamId: 'team-treeseed', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane', connectionRef: 'cloudflare-state', bucket: 'treeseed-infrastructure-state', key: hostedTopologyStateKey({ teamId: 'team-treeseed', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane' }), region: 'auto', endpoint: 'https://r2.example.test', usePathStyle: true, encryptionKeyRef: 'treeseed-cloud-state' });
function plan(observations: HostedResourceObservation[] = []) { return planHostedTopology({ declaration: topology(), observations, connections: connections(), stateBackend: backend }); }
function approved(input = plan()) { return authorizeHostedTopologyPlan(input, { schemaVersion: 'treeseed.hosted-topology-approval/v1', planDigest: input.planDigest, teamId: input.teamId, deploymentId: input.deploymentId, stackId: input.stackId, environment: input.environment, backendBindingDigest: input.stateBackend!.bindingDigest, decision: 'approved', approvedBy: 'release-approver', approvedAt: now }); }

const values = (request: HostedInfrastructureAuthorityRequest) => request.credentialProfileId === 'railway-workspace' ? { apiToken: 'railway-secret' }
	: request.credentialProfileId === 's3-state-session' ? { accessKeyId: 'state-key', secretAccessKey: 'state-secret', sessionToken: 'state-session' }
		: request.credentialProfileId === 'opentofu-state-encryption' ? { key: 'a'.repeat(64) }
		: { apiToken: request.credentialProfileId === 'cloudflare-dns' ? 'dns-secret' : 'runtime-secret' };
const vaultResolver = async (request: HostedInfrastructureAuthorityRequest) => ({ schemaVersion: 'treeseed.service-credential-material/v1' as const, source: 'treeseed-service-credential-vault' as const, requestId: request.requestId, teamId: request.teamId, deploymentId: request.deploymentId, stackId: request.stackId, authorityId: `authority-${request.credentialProfileId}`, authorityVersion: 2, environment: request.environment, backendBindingDigest: request.backendBindingDigest, provider: request.provider, connectionRef: request.connectionRef, ...(request.secretRef ? { secretRef: request.secretRef } : {}), credentialProfileId: request.credentialProfileId, capabilities: request.capabilities, purpose: request.purpose, scheme: 'external-vault' as const, expiresAt: request.purpose === 'provider' ? null : new Date(Date.now() + 30 * 60 * 1_000).toISOString(), values: values(request) });

describe('Deployment-owned OpenTofu hosted infrastructure', () => {
	it('locks the exact OpenTofu and provider supply chain', async () => {
		expect(hostedInfrastructureToolchain.opentofu.version).toBe('1.12.6');
		expect(hostedInfrastructureToolchain.providers.cloudflare).toEqual({ source: 'registry.opentofu.org/cloudflare/cloudflare', version: '5.24.0' });
		expect(hostedInfrastructureToolchain.providers.railway.source).toBe('registry.opentofu.org/jamesprnich/railway');
		const lock = await readFile(new URL('../infrastructure/opentofu/hosted-topology/.terraform.lock.hcl', import.meta.url), 'utf8');
		expect(lock).toContain('registry.opentofu.org/cloudflare/cloudflare'); expect(lock).toContain('registry.opentofu.org/jamesprnich/railway'); expect(lock).toContain('0.11.5');
	});

	it('acquires the exact pinned OpenTofu binary inside the private workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-acquire-')); roots.push(root);
		const archive = Buffer.from('locked-opentofu-archive');
		const expected = createHash('sha256').update(archive).digest('hex');
		const locked = hostedInfrastructureToolchain.opentofu as { linuxAmd64ArchiveSha256: string };
		const previous = locked.linuxAmd64ArchiveSha256; locked.linuxAmd64ArchiveSha256 = expected;
		try {
			const binary = await acquireOpenTofu(root, {
				platform: 'linux', arch: 'x64', fetchImpl: async (input) => { expect(String(input)).toBe(openTofuArchive('linux', 'x64').url); return new Response(archive); },
				extract: async (_source, destination) => { await writeFile(join(destination, 'tofu'), '#!/bin/sh\n', { mode: 0o600 }); },
			});
			expect(binary.startsWith(root)).toBe(true); expect((await stat(binary)).mode & 0o777).toBe(0o700);
		} finally { locked.linuxAmd64ArchiveSha256 = previous; }
	});

	it('fails closed for unsupported runners and archive digest drift', async () => {
		expect(() => openTofuArchive('darwin', 'arm64')).toThrow(/only on Linux/u);
		expect(() => openTofuArchive('linux', 'riscv64')).toThrow(/does not support/u);
		const root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-drift-')); roots.push(root);
		await expect(acquireOpenTofu(root, { platform: 'linux', arch: 'x64', fetchImpl: async () => new Response('wrong') })).rejects.toThrow(/digest verification/u);
	});

	it('renders a deterministic, portable, credential-free workspace', () => {
		const first = renderHostedInfrastructureWorkspace({ plan: plan() }), second = renderHostedInfrastructureWorkspace({ plan: plan() });
		expect(second.bundleDigest).toBe(first.bundleDigest); expect(first.executable).toBe(false);
		expect(Object.keys(first.files)).toEqual(expect.arrayContaining(['versions.tf', 'main.tf', '.terraform.lock.hcl', 'backend.tf.json', 'terraform.tfvars.json']));
		expect(JSON.parse(first.files['backend.tf.json']!).terraform.backend.s3).toMatchObject({ key: 'teams/team-treeseed/opentofu/v1/deployments/treeseed-cloud/environments/production/stacks/control-plane/terraform.tfstate', encrypt: true, use_lockfile: true });
		expect(JSON.parse(first.files['encryption.tf.json']!).terraform.encryption).toEqual({ state: { enforced: true }, plan: { enforced: true } });
		const rendered = Object.values(first.files).join('\n');
		expect(rendered).toContain('cloudflare_pages_project'); expect(rendered).toContain('cloudflare_workers_script'); expect(rendered).toContain('railway_service_instance'); expect(rendered).toContain('railway_variable');
		expect(rendered).not.toMatch(/railway-secret|dns-secret|runtime-secret|state-secret/u);
		expect(first.artifacts).toEqual([{ id: 'admin', source: 'https://artifacts.example.test/admin.mjs', digest: digest(workerSource), path: 'artifacts/admin' }]);
		expect(renderHostedInfrastructureWorkspace({ plan: approved() }).executable).toBe(true);
		expect(() => renderHostedInfrastructureWorkspace({ plan: { ...approved(), stateBackend: { ...backend, teamId: 'other-team' } } as never })).toThrow(/custody|digest/u);
	});

	it('requires environment-bound TreeSeed service-vault authority', async () => {
		const workspace = renderHostedInfrastructureWorkspace({ plan: approved() });
		expect(workspace.authorities.map(({ credentialProfileId }) => credentialProfileId)).toEqual(['cloudflare-dns', 'cloudflare-runtime', 'railway-workspace', 's3-state-session', 'opentofu-state-encryption']);
		expect(workspace.authorities.find(({ purpose }) => purpose === 'state-encryption')).toMatchObject({ connectionRef: 'cloudflare-state', secretRef: 'treeseed-cloud-state' });
		const authority = await resolveHostedInfrastructureVaultAuthority(workspace, vaultResolver);
		expect(authority.environment).toBe('production');
		await expect(resolveHostedInfrastructureVaultAuthority(workspace, async (request) => ({ ...await vaultResolver(request), environment: 'staging' }))).rejects.toThrow(/environment/u);
		await expect(resolveHostedInfrastructureVaultAuthority(workspace, async (request) => ({ ...await vaultResolver(request), source: 'caller-environment' as any }))).rejects.toThrow(/service credential vault/u);
		await expect(resolveHostedInfrastructureVaultAuthority(workspace, async (request) => ({ ...await vaultResolver(request), expiresAt: '2026-01-01T00:00:00.000Z' }), new Date('2026-09-02T00:00:00.000Z'))).rejects.toThrow(/expired/u);
		await expect(resolveHostedInfrastructureVaultAuthority(workspace, async (request) => ({ ...await vaultResolver(request), teamId: 'other-team' }))).rejects.toThrow(/teamId/u);
		await expect(resolveHostedInfrastructureVaultAuthority(workspace, async (request) => ({ ...await vaultResolver(request), expiresAt: request.purpose === 'state-backend' ? new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString() : request.purpose === 'provider' ? null : new Date(Date.now() + 30 * 60 * 1_000).toISOString() }))).rejects.toThrow(/short-lived session/u);
	});

	it('discovers adoption candidates only through custody-bound Deployment provider authority', async () => {
		const original = topology(), declaration = hostedTopologyDeclarationSchema.parse({ ...original,
			resources: original.resources.filter(({ id }) => ['admin', 'api'].includes(id)).map((resource) => ({ ...resource, dependsOn: [] })) });
		const requests = hostedInfrastructureDiscoveryRequests({ declaration, stateBackend: backend });
		expect(requests.every(({ teamId, deploymentId, stackId, backendBindingDigest, purpose }) => teamId === 'team-treeseed' && deploymentId === 'treeseed-cloud' && stackId === 'control-plane' && backendBindingDigest === backend.bindingDigest && purpose === 'provider')).toBe(true);
		const authority = { schemaVersion: 'treeseed.hosted-infrastructure-authority/v1' as const, environment: 'production' as const, materials: await Promise.all(requests.map(vaultResolver)) };
		const root = await mkdtemp(join(tmpdir(), 'treeseed-discovery-')); roots.push(root);
		const fetchImpl = async (url: string | URL | Request) => String(url).includes('cloudflare.com')
			? Response.json({ success: true, result: { name: 'treeseed-admin', production_branch: 'main', build_config: { destination_dir: '.treeseed/app-dist' }, deployment_configs: { production: { env_vars: {} } } } })
			: Response.json({ data: { project: { services: { edges: [] } }, variables: {} } });
		const observations = await discoverHostedInfrastructure({ declaration, stateBackend: backend, connections: connections(), authority, root, fetchImpl: fetchImpl as typeof fetch });
		expect(observations.find(({ resourceId }) => resourceId === 'admin')).toMatchObject({ state: 'healthy', managedBy: 'external' });
		expect(observations.find(({ resourceId }) => resourceId === 'api')).toMatchObject({ state: 'missing', providerResourceId: null });
	});

	it('rejects a connection bound to a different deployment environment', () => {
		const selected = connections(); selected.railway.nonSecretConfig.deploymentEnvironment = 'staging';
		const mismatched = planHostedTopology({ declaration: topology(), observations: [], connections: selected, stateBackend: backend });
		expect(() => renderHostedInfrastructureWorkspace({ plan: mismatched })).toThrow(/not bound to the production/u);
	});

	it('renders imports for reviewed existing resources without replacement', () => {
		const declaration = topology(), observations = declaration.resources.map((resource): HostedResourceObservation => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: `${resource.id}-provider-id`, state: 'healthy', managedBy: 'treeseed', observedDigest: null, observedAt: now }));
		const workspace = renderHostedInfrastructureWorkspace({ plan: approved(plan(observations)) });
		expect(workspace.imports).toContainEqual({ address: 'cloudflare_pages_project.managed["admin"]', id: 'cf-account/treeseed-admin' });
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
			if (args[0] === 'plan' && args.some((value) => value.startsWith('-out='))) { await writeFile(join(options.cwd, 'treeseed.plan'), 'immutable-binary-plan'); return { code: 2, stdout: '', stderr: '' }; }
			if (args[0] === 'output') return { code: 0, stdout: JSON.stringify({ cloudflare_pages: { value: { admin: 'pages-id' } }, cloudflare_dns_records: { value: { 'admin-dns': 'dns-id' } }, cloudflare_tls_policies: { value: { 'admin-tls': 'tls-id' } }, railway_services: { value: { api: 'api-id', postgres: 'postgres-id' } } }), stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		};
		const executor = new HostedInfrastructureExecutor(command, async () => new Response(workerSource));
		const unauthorized = renderHostedInfrastructureWorkspace({ plan: plan() });
		const authority = await resolveHostedInfrastructureVaultAuthority(unauthorized, vaultResolver), result = await executor.plan(unauthorized, root, authority);
		await expect(executor.apply(unauthorized, root, authority, result)).rejects.toThrow(/authorized executable/u);
		const authorized = renderHostedInfrastructureWorkspace({ plan: approved() });
		const authorizedAuthority = await resolveHostedInfrastructureVaultAuthority(authorized, vaultResolver);
		const approvedResult = await executor.plan(authorized, root, authorizedAuthority);
		const rotatedAuthority = { ...authorizedAuthority, materials: authorizedAuthority.materials.map((material, index) => index ? material : { ...material, authorityVersion: material.authorityVersion + 1 }) };
		await expect(executor.apply(authorized, root, rotatedAuthority, approvedResult)).rejects.toThrow(/changed after planning/u);
		await expect(executor.apply(authorized, root, authorizedAuthority, { ...approvedResult, executionPlanDigest: `sha256:${'f'.repeat(64)}` })).rejects.toThrow(/approved digest/u);
		expect((await executor.apply(authorized, root, authorizedAuthority, approvedResult)).applied).toBe(true);
		const observations = await executor.readback(authorized, root, authorizedAuthority);
		expect(observations).toHaveLength(5); expect(observations.every(({ state, managedBy }) => state === 'healthy' && managedBy === 'treeseed')).toBe(true);
		expect(calls.some((args) => args[0] === 'init')).toBe(true); expect(calls.some((args) => args[0] === 'apply')).toBe(true);
	});

	it('rejects authoritative read-back when refresh detects drift', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-drift-readback-')); roots.push(root);
		const workspace = renderHostedInfrastructureWorkspace({ plan: approved() }), authority = await resolveHostedInfrastructureVaultAuthority(workspace, vaultResolver);
		const executor = new HostedInfrastructureExecutor(async (args) => args[0] === 'plan' ? { code: 2, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
		await expect(executor.readback(workspace, root, authority)).rejects.toThrow(/detected hosted infrastructure drift/u);
	});

	it('executes only a complete approved rollback closure and reads back removals', async () => {
		const sourcePlan = approved(), observedAt = now;
		const resources: HostedResourceObservation[] = sourcePlan.actions.map((action, index) => ({ resourceId: action.resourceId, provider: action.provider, kind: action.kind, providerResourceId: `${action.resourceId}-id`, state: 'healthy', managedBy: 'treeseed', observedDigest: action.desiredDigest, observedAt }));
		const previousResources = resources.map((resource) => resource.provider === 'cloudflare' ? { ...resource, providerResourceId: null, state: 'missing' as const, managedBy: null, observedDigest: null } : resource);
		const receipt = verifyHostedTopologyReadback({ plan: sourcePlan, previousResources, resources, completedAt: now });
		const rollback = planHostedTopologyRollback(receipt), declaration = topology();
		const targetDeclaration = hostedTopologyDeclarationSchema.parse({ ...declaration, resources: declaration.resources.filter(({ provider }) => provider === 'railway') });
		const targetPlan = planHostedTopology({ declaration: targetDeclaration, observations: previousResources.filter(({ provider }) => provider === 'railway'), connections: connections(), stateBackend: backend });
		const execution = planHostedTopologyRollbackExecution({ rollback, sourceReceipt: receipt, sourcePlan, targetPlan });
		const workspace = renderHostedInfrastructureRollbackWorkspace({ execution, approval: { schemaVersion: 'treeseed.hosted-topology-rollback-execution-approval/v1', executionDigest: execution.executionDigest, teamId: execution.teamId, deploymentId: execution.deploymentId, stackId: execution.stackId, environment: rollback.environment, backendBindingDigest: execution.backendBindingDigest, decision: 'approved', approvedBy: 'release-approver', approvedAt: now }, sourceReceipt: receipt, sourcePlan, targetPlan });
		expect(workspace.executable).toBe(true); expect(workspace.planDigest).toBe(rollback.rollbackDigest); expect(workspace.files['main.tf']).toContain('prevent_destroy = false');
		expect(workspace.removedResources.map(({ resourceId }) => resourceId)).toEqual(['admin', 'admin-dns', 'admin-tls']);
		expect(workspace.authorities.map(({ credentialProfileId }) => credentialProfileId)).toEqual(['cloudflare-dns', 'cloudflare-runtime', 'railway-workspace', 's3-state-session', 'opentofu-state-encryption']);
		const authority = await resolveHostedInfrastructureVaultAuthority(workspace, vaultResolver), root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-rollback-')); roots.push(root);
		const command: OpenTofuCommand = async (args, options) => {
			if (args[0] === 'version') return { code: 0, stdout: JSON.stringify({ terraform_version: '1.12.6' }), stderr: '' };
			if (args[0] === 'plan' && args.some((value) => value.startsWith('-out='))) { await writeFile(join(options.cwd, 'treeseed.plan'), 'rollback-plan'); return { code: 2, stdout: '', stderr: '' }; }
			if (args[0] === 'output') return { code: 0, stdout: JSON.stringify({ railway_services: { value: { api: 'api-id', postgres: 'postgres-id' } } }), stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		};
		const executor = new HostedInfrastructureExecutor(command, async () => new Response(workerSource));
		const binaryExecution = await executor.plan(workspace, root, authority); await executor.apply(workspace, root, authority, binaryExecution);
		const readback = await executor.readback(workspace, root, authority);
		expect(readback.filter(({ state }) => state === 'missing').map(({ resourceId }) => resourceId)).toEqual(['admin', 'admin-dns', 'admin-tls']);
	});

	it('redacts provider authority from failures', async () => {
		const executor = new HostedInfrastructureExecutor(async () => ({ code: 1, stdout: '', stderr: 'provider rejected super-secret' }));
		await expect(executor.verifyVersion('/tmp', { RAILWAY_TOKEN: 'super-secret' })).rejects.not.toThrow(/super-secret/u);
	});

	it('redacts service-vault material from OpenTofu failures', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-opentofu-redaction-')); roots.push(root);
		const workspace = renderHostedInfrastructureWorkspace({ plan: approved() }), authority = await resolveHostedInfrastructureVaultAuthority(workspace, vaultResolver);
		const executor = new HostedInfrastructureExecutor(async (args) => args[0] === 'version'
			? { code: 0, stdout: JSON.stringify({ terraform_version: '1.12.6' }), stderr: '' }
			: { code: 1, stdout: '', stderr: 'provider returned runtime-secret and state-secret' }, async () => new Response(workerSource));
		let message = '';
		try { await executor.plan(workspace, root, authority); } catch (error) { message = error instanceof Error ? error.message : String(error); }
		expect(message).not.toMatch(/runtime-secret|state-secret/u); expect(message).toContain('[redacted]');
	});
});
