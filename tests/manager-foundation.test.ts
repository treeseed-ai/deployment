import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activationEligible, aptPreferencesForTrack, aptSuiteForRefresh, assertTreeDxResetSafe, availableCatalogSummary, catalogPackagesForTrack, componentActivationOrder, componentStateDirectories, componentStateRoot, componentStopOrder, corePackagesForTrack, createPlan, developmentEnvironmentPayloadSchema, edgeRoutes, executeSupervisorOperation, hostCommandRequestSchema, installPackages, managedCliControlPlaneUrl, managedConnectionEnvironment, managedContainerDevelopmentConnectionEnvironment, managedDevelopmentConnectionEnvironment, metadataRefreshDue, packageFromTrack, pollIntervalSeconds, recoverInvalidConfiguration, renderCaddyfile, renderComponentEnvironment, resetPlatformState, resolveDevelopmentSecretEnvironment, rollbackRoutes, serializedReconcileArguments, serializedResetArguments, stableActivationWindow, subjectAlternativeNames, supervisorOperationSchema, tryLoadHostConfiguration, updateTrack, validateProductionCompose, withCoreUpgradeHandoff, withDeferredManagerRestart } from '../src/index.js';
import { loadActiveComponents, loadCurrentReceipt } from '../src/manager/current-state.js';
import { catalogs, component, hash, host } from './fixtures.js';

describe('unified host manager foundation', () => {
	it('activates local dependencies before consumers and stops them in reverse order', () => {
		const configuration = host(), api = component('api', 'stable', 'a'), admin = component('admin', 'development', 'b');
		admin.runtime.dependencies = [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.admin = { enabled: true, track: 'development', aliases: {}, connections: { api: { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } }, configuration: {} } as any;
		expect(componentActivationOrder(configuration, [admin, api]).map(({ componentId }) => componentId)).toEqual(['api', 'admin']);
		expect(componentStopOrder(configuration, [admin, api]).map(({ componentId }) => componentId)).toEqual(['admin', 'api']);
	});

	it('fails closed when local component dependencies cycle or are unavailable', () => {
		const configuration = host(), api = component('api', 'stable', 'a'), admin = component('admin', 'development', 'b');
		admin.runtime.dependencies = [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.admin = { enabled: true, track: 'development', aliases: {}, connections: { api: { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } }, configuration: {} } as any;
		expect(() => componentActivationOrder(configuration, [admin])).toThrow(/unavailable local component api/u);
		api.runtime.dependencies = [{ id: 'admin', capability: 'admin-ui', locality: 'either', optional: false }];
		configuration.components.api!.connections.admin = { kind: 'local', componentId: 'admin', serviceId: 'service', endpointId: 'http' };
		expect(() => componentActivationOrder(configuration, [admin, api])).toThrow(/dependency cycle: admin, api/u);
	});

	it('declares local provider synthesis only for an explicit local control-plane connection', () => {
		const configuration = host(), agent = component('agent', 'development', 'c'), api = component('api', 'stable', 'b');
		agent.runtime.dependencies = [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.agent!.connections['control-plane'] = { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' };
		expect(managedConnectionEnvironment(configuration, agent, [agent, api])).toMatchObject({ TREESEED_PROVIDER_ENVIRONMENT: 'local', TREESEED_CONTROL_PLANE_URL: 'http://service:3000' });
		configuration.components.agent!.connections['control-plane'] = { kind: 'remote', url: 'https://api.example.test', audience: 'https://api.example.test', tls: { trust: 'system' }, authentication: { mode: 'none' }, healthGate: { protocol: 'http', path: '/v1/health/ready', timeoutSeconds: 30 } };
		expect(managedConnectionEnvironment(configuration, agent, [agent, api])).toMatchObject({ TREESEED_PROVIDER_ENVIRONMENT: 'managed', TREESEED_CONTROL_PLANE_URL: 'https://api.example.test' });
		const admin = { ...agent, componentId: 'admin', runtime: { ...agent.runtime,
			dependencies: [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }] } } as any;
		configuration.components.admin = { enabled: true, track: 'development', aliases: {},
			connections: { api: { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } }, configuration: {} } as any;
		expect(managedConnectionEnvironment(configuration, admin, [admin, api])).toMatchObject({ TREESEED_API_BASE_URL: 'http://service:3000' });
	});

	it('resolves containerized development consumers to released or live private dependencies', () => {
		const configuration = host(), api = component('api', 'stable', 'a'), admin = component('admin', 'development', 'b');
		admin.runtime.dependencies = [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.admin = { enabled: true, track: 'development', aliases: {}, connections: { api: { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } }, configuration: {} } as any;
		expect(managedContainerDevelopmentConnectionEnvironment(configuration, admin, [admin, api], [])).toMatchObject({
			TREESEED_API_BASE_URL: 'http://service:3000', TREESEED_API_AUDIENCE: 'https://api.treeseed.localhost',
		});
		expect(managedContainerDevelopmentConnectionEnvironment(configuration, admin, [admin, api], [{ alias: 'api.treeseed.localhost', upstream: 'http://api-live:3000', authentication: 'application' }])).toMatchObject({
			TREESEED_API_BASE_URL: 'http://api-live:3000', TREESEED_API_AUDIENCE: 'https://api.treeseed.localhost',
		});
		expect(managedDevelopmentConnectionEnvironment(configuration, admin, [admin, api])).toMatchObject({
			TREESEED_API_BASE_URL: 'https://api.treeseed.localhost', NODE_EXTRA_CA_CERTS: '/etc/treeseed/cli/localhost-ca.crt',
		});
		configuration.components.admin!.connections.api = { kind: 'remote', url: 'https://api.example.test/', audience: 'https://api.example.test', tls: { trust: 'system' }, authentication: { mode: 'none' }, healthGate: { protocol: 'http', path: '/v1/health/ready', timeoutSeconds: 30 } };
		expect(managedContainerDevelopmentConnectionEnvironment(configuration, admin, [admin, api], [{ alias: 'api.treeseed.localhost', upstream: 'http://api-live:3000', authentication: 'application' }])).toMatchObject({
			TREESEED_API_BASE_URL: 'https://api.example.test', TREESEED_API_AUDIENCE: 'https://api.example.test',
		});
	});

	it('plans a stable base with only explicit development overlays', () => {
		const configuration = host(), { stable, development } = catalogs();
		const accepted = createPlan(configuration, stable, development);
		expect(accepted.components.map((item) => `${item.componentId}:${item.track}`)).toEqual(['agent:development', 'api:stable']);
		expect(accepted.routes.map((route) => route.alias)).toEqual(['agent.treeseed.localhost', 'api.treeseed.localhost', 'manager.treeseed.localhost']);
		expect(accepted.routes.find((route) => route.alias.startsWith('manager'))).toMatchObject({ authentication: 'mtls', upstream: 'unix//run/treeseed/manager/api.sock' });
	});

	it('fails closed on unknown alias identities and applies fully qualified overrides', () => {
		const configuration = host(), { stable, development } = catalogs();
		configuration.components.api!.aliases = { 'api.http': 'api-preview.treeseed.localhost' };
		expect(() => createPlan(configuration, stable, development)).toThrow(/does not identify an accepted host endpoint/u);
		configuration.components.api!.aliases = { 'api.service.http': 'api-preview.treeseed.localhost' };
		expect(createPlan(configuration, stable, development).routes.map((route) => route.alias)).toContain('api-preview.treeseed.localhost');
	});

	it('renders one certificate identity set and mTLS manager policy', () => {
		const routes = [...edgeRoutes([component('api', 'stable', 'b')]), { alias: 'manager.treeseed.localhost', upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' as const }];
		const caddyfile = renderCaddyfile(routes);
		expect(subjectAlternativeNames(routes)).toEqual(['api.treeseed.localhost', 'manager.treeseed.localhost']);
		expect(caddyfile).toContain('mode require_and_verify');
		expect(caddyfile).toContain('reverse_proxy unix//run/treeseed/manager/api.sock');
		expect(caddyfile.match(/\{/gu)).toHaveLength(caddyfile.match(/\}/gu)!.length);
		expect(caddyfile).toMatch(/reverse_proxy unix\/\/run\/treeseed\/manager\/api\.sock\n\}\n$/u);
	});

	it('rolls an empty first generation back to the manager route only', () => {
		expect(rollbackRoutes(host(), [])).toEqual([{ alias: 'manager.treeseed.localhost', upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' }]);
	});

	it('rejects source builds, mutable images, and host port publication', () => {
		const release = component('api', 'stable', 'b'), root = mkdtempSync(resolve(tmpdir(), 'treeseed-compose-'));
		const file = resolve(root, 'compose.yml');
		const bindCompose = () => { release.runtime.compose.files[0]!.digest = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`; };
		const image = `treeseed/api@${hash('b')}`;
		const valid = (extra = '') => `services:\n  service:\n    image: ${image}\n    healthcheck: { test: ["CMD", "true"] }\n${extra}`;
		writeFileSync(file, valid());
		bindCompose();
		expect(() => validateProductionCompose(release, root)).not.toThrow();
		writeFileSync(file, `services:\n  service:\n    build: .\n    image: ${image}\n    healthcheck: { test: ["CMD", "true"] }\n`);
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/forbidden Compose build/u);
		writeFileSync(file, 'services:\n  service:\n    image: treeseed/api:latest\n');
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/immutable image digest/u);
		writeFileSync(file, valid('    ports: ["3000:3000"]\n'));
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/publishes a host port/u);
		writeFileSync(file, valid('    volumes: ["./source:/app"]\n'));
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/relative source mount/u);
		writeFileSync(file, valid('    volumes: ["/home/developer/project:/app"]\n'));
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/outside manager-owned roots/u);
		writeFileSync(file, valid('    volumes: ["/var/lib/treeseed/components/api:/data", "api-cache:/cache"]\n'));
		bindCompose();
		expect(() => validateProductionCompose(release, root)).not.toThrow();
		writeFileSync(file, `services:\n  service:\n    image: ${image}\n`);
		bindCompose();
		expect(() => validateProductionCompose(release, root)).toThrow(/neither a Compose health gate nor a one-shot completion gate/u);
		writeFileSync(file, `services:\n  service:\n    image: ${image}\n    restart: "no"\n`);
		bindCompose();
		expect(() => validateProductionCompose(release, root)).not.toThrow();
	});

	it('keeps root execution within the fixed protocol', () => {
		const calls: Array<[string, readonly string[]]> = [];
		expect(executeSupervisorOperation({ operation: 'supervisor.ping' }, (executable, arguments_) => calls.push([executable, arguments_]))).toEqual({ ready: true });
		executeSupervisorOperation({ operation: 'systemd.control', unit: 'treeseed-edge.service', action: 'reload' }, (executable, arguments_) => calls.push([executable, arguments_]));
		expect(calls).toEqual([['/usr/bin/systemctl', ['reload', 'treeseed-edge.service']]]);
		expect(() => executeSupervisorOperation({ operation: 'systemd.control', unit: 'ssh.service', action: 'restart' }, () => undefined)).toThrow();
		expect(() => executeSupervisorOperation({ operation: 'shell', command: 'id' }, () => undefined)).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'apt.refresh', track: 'development', updateCore: false })).toEqual({ operation: 'apt.refresh', track: 'development', updateCore: false });
		expect(supervisorOperationSchema.parse({ operation: 'backup.create', generation: 42 })).toEqual({ operation: 'backup.create', generation: 42 });
		expect(supervisorOperationSchema.parse({ operation: 'backup.inspect', generation: 42 })).toEqual({ operation: 'backup.inspect', generation: 42 });
		expect(supervisorOperationSchema.parse({ operation: 'backup.list' })).toEqual({ operation: 'backup.list' });
		expect(supervisorOperationSchema.parse({ operation: 'compose.status', projectName: 'treeseed-api' })).toEqual({ operation: 'compose.status', projectName: 'treeseed-api' });
		expect(supervisorOperationSchema.parse({ operation: 'manager.restart' })).toEqual({ operation: 'manager.restart' });
		expect(supervisorOperationSchema.parse({ operation: 'supervisor.ping' })).toEqual({ operation: 'supervisor.ping' });
		expect(supervisorOperationSchema.parse({ operation: 'component.reset-unaccepted', componentId: 'api' })).toEqual({ operation: 'component.reset-unaccepted', componentId: 'api' });
		expect(supervisorOperationSchema.parse({ operation: 'development.environment', componentId: 'api', connectionEnvironment: {}, secretRefs: { TREESEED_DATABASE_URL: 'api-database-url' } })).toEqual({ operation: 'development.environment', componentId: 'api', connectionEnvironment: {}, secretRefs: { TREESEED_DATABASE_URL: 'api-database-url' } });
		expect(() => supervisorOperationSchema.parse({ operation: 'development.environment', componentId: 'api', connectionEnvironment: {}, secretRefs: { TREESEED_DATABASE_URL: '../other-secret' } })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'platform.reset', componentDataRoot: '/var/lib/treeseed/components' })).toEqual({ operation: 'platform.reset', componentDataRoot: '/var/lib/treeseed/components' });
		expect(supervisorOperationSchema.parse({ operation: 'platform.reset', componentDataRoot: '/work/platform/.treeseed/data' })).toEqual({ operation: 'platform.reset', componentDataRoot: '/work/platform/.treeseed/data' });
		expect(() => supervisorOperationSchema.parse({ operation: 'platform.reset', componentDataRoot: '/home' })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'cli.configure', controlPlaneUrl: 'https://api.treeseed.localhost' })).toEqual({ operation: 'cli.configure', controlPlaneUrl: 'https://api.treeseed.localhost' });
		expect(() => supervisorOperationSchema.parse({ operation: 'cli.configure', controlPlaneUrl: 'http://api.example.test' })).toThrow();
		executeSupervisorOperation({ operation: 'manager.restart' }, (executable, arguments_) => calls.push([executable, arguments_]));
		expect(calls.at(-1)).toEqual(['/usr/bin/systemctl', ['--no-block', 'start', 'treeseed-manager-restart.service']]);
		expect(() => supervisorOperationSchema.parse({ operation: 'apt.refresh', track: 'nightly', updateCore: true })).toThrow();
	});

	it('restores temporary component-secret custody on activation failure and stop', () => {
		const restored: string[] = [];
		const activation = { operation: 'compose.activate', componentId: 'ai-lab', files: ['ai-lab/release/compose.yml'], projectName: 'treeseed-ai-lab', waitTimeoutSeconds: 120 };
		expect(() => executeSupervisorOperation(activation, (executable, arguments_) => {
			if (executable === '/usr/bin/docker' && arguments_.includes('inspect')) return undefined;
			throw new Error('activation failed');
		}, (componentId) => restored.push(componentId))).toThrow(/activation failed/u);
		expect(restored).toEqual(['ai-lab']);
		executeSupervisorOperation({ operation: 'compose.stop', componentId: 'ai-lab', files: ['ai-lab/release/compose.yml'], projectName: 'treeseed-ai-lab' }, () => undefined, (componentId) => restored.push(componentId));
		expect(restored).toEqual(['ai-lab', 'ai-lab']);
		expect(() => executeSupervisorOperation({ operation: 'compose.stop', componentId: 'ai-lab', files: ['ai-lab/release/compose.yml'], projectName: 'treeseed-ai-lab' }, (_executable, arguments_) => {
			if (arguments_[0] === 'ps') return '';
			throw new Error('compose project no longer exists');
		}, (componentId) => restored.push(componentId))).not.toThrow();
		const status = executeSupervisorOperation({ operation: 'compose.status', projectName: 'treeseed-ai-lab' }, (_executable, arguments_) => arguments_.includes('--all') ? 'one\ntwo\n' : 'one\n');
		expect(status).toEqual({ present: true, running: true, containers: 2, runningContainers: 1 });
	});

	it('limits GPU lifecycle execution to fixed TreeAI services and gate executables', () => {
		const calls: Array<readonly string[]> = [];
		const gate = executeSupervisorOperation({ operation: 'ai.gpu.gate', role: 'training', action: 'close', files: ['ai-training/release/compose.yml'] }, (_executable, arguments_) => { calls.push(arguments_); return '{"admission":"closed","active":0}'; });
		expect(gate).toEqual({ role: 'training', admission: 'closed', active: 0 });
		expect(calls[0]).toEqual(['compose', '--env-file', '/etc/treeseed/components/ai-training/environment', '--file', '/usr/share/treeseed/components/ai-training/release/compose.yml', '--project-name', 'treeseed-ai-training', 'exec', '-T', 'training-api', '/usr/local/bin/treeseed-ai-gpu-gate', 'close']);
		const workload = executeSupervisorOperation({ operation: 'ai.gpu.workload', role: 'inference', action: 'status', files: ['ai-inference/release/compose.yml'] }, (_executable, arguments_) => { calls.push(arguments_); return 'inference-vllm\n'; });
		expect(workload).toMatchObject({ role: 'inference', ready: true, running: ['inference-vllm'] });
		expect(() => supervisorOperationSchema.parse({ operation: 'ai.gpu.workload', role: 'lab', action: 'start', files: ['compose.yml'] })).toThrow();
		expect(() => supervisorOperationSchema.parse({ operation: 'ai.gpu.workload', role: 'training', action: 'kill', files: ['compose.yml'] })).toThrow();
	});

	it('removes only resettable platform state and recreates empty managed roots', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-platform-reset-'));
		const targets = { components: resolve(root, 'var/lib/treeseed/components'), componentConfiguration: resolve(root, 'etc/treeseed/components'), managerState: resolve(root, 'var/lib/treeseed/manager'), backups: resolve(root, 'var/lib/treeseed/backups') };
		for (const directory of [targets.components, targets.componentConfiguration, targets.managerState, targets.backups]) mkdirSync(directory, { recursive: true });
		writeFileSync(resolve(targets.components, 'database'), 'state');
		writeFileSync(resolve(targets.componentConfiguration, 'environment'), 'config');
		writeFileSync(resolve(targets.managerState, 'current-receipt.json'), '{}');
		writeFileSync(resolve(targets.managerState, 'bootstrap-status.json'), '{"complete":true}');
		writeFileSync(resolve(targets.backups, 'generation-1.tar.gz'), 'backup');
		const result = resetPlatformState(targets);
		expect(result.reset).toBe(true);
		expect(readdirSync(targets.components)).toEqual([]);
		expect(readdirSync(targets.componentConfiguration)).toEqual([]);
		expect(readdirSync(targets.backups)).toEqual([]);
		expect(existsSync(resolve(targets.managerState, 'current-receipt.json'))).toBe(false);
		expect(readFileSync(resolve(targets.managerState, 'bootstrap-status.json'), 'utf8')).toBe('{"complete":true}');
	});

	it('blocks reset when TreeDX has active or unpublished authoring', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reset-safety-'));
		const active = resolve(root, 'treedx/data/workspaces/active/ws-active');
		mkdirSync(active, { recursive: true });
		await expect(assertTreeDxResetSafe(root)).rejects.toThrow(/active TreeDX workspace/u);
		const cleanRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-reset-safety-'));
		const repository = resolve(cleanRoot, 'treedx/data/repos/bare/repo.git');
		mkdirSync(repository, { recursive: true });
		execFileSync('/usr/bin/git', ['init', '--bare', repository]);
		const tree = execFileSync('/usr/bin/git', ['--git-dir', repository, 'mktree'], { input: '', encoding: 'utf8' }).trim();
		const commit = execFileSync('/usr/bin/git', ['--git-dir', repository, 'commit-tree', tree, '-m', 'unpublished'], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'TreeSeed test', GIT_AUTHOR_EMAIL: 'test@treeseed.local', GIT_COMMITTER_NAME: 'TreeSeed test', GIT_COMMITTER_EMAIL: 'test@treeseed.local' } }).trim();
		execFileSync('/usr/bin/git', ['--git-dir', repository, 'update-ref', 'refs/heads/agent/unpublished', commit]);
		await expect(assertTreeDxResetSafe(cleanRoot)).rejects.toThrow(/unpublished TreeDX branch/u);
		execFileSync('/usr/bin/git', ['--git-dir', repository, 'update-ref', '-d', 'refs/heads/agent/unpublished']);
		execFileSync('/usr/bin/git', ['--git-dir', repository, 'update-ref', 'refs/heads/main', commit]);
		await expect(assertTreeDxResetSafe(cleanRoot)).rejects.toThrow(/unpublished TreeDX branch/u);
		execFileSync('/usr/bin/git', ['--git-dir', repository, 'update-ref', 'refs/remotes/origin/main', commit]);
		await expect(assertTreeDxResetSafe(cleanRoot)).resolves.toEqual({ activeWorkspaces: 0, unpublishedBranches: 0 });
	});

	it('returns reset manager state to the unprivileged manager account', () => {
		const supervisor = readFileSync(resolve(process.cwd(), 'src/supervisor/execute.ts'), 'utf8');
		const postinst = readFileSync(resolve(process.cwd(), 'debian/manager/postinst'), 'utf8');
		expect(supervisor.indexOf("writeFileSync(`${paths.managerState}/events.jsonl`, ''")).toBeLessThan(supervisor.indexOf("command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState])"));
		expect(supervisor).toContain("command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState])"); expect(supervisor).toContain("publicJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x }");
		expect(postinst).toContain('chown -R treeseed-manager:treeseed-manager /var/lib/treeseed/manager'); expect(postinst).toContain('systemctl restart treeseed-manager-stable.timer treeseed-manager-development.timer');
		for (const contract of ['touch /var/lib/treeseed/manager/events.jsonl', 'chown treeseed-manager:treeseed-manager /var/lib/treeseed/manager/events.jsonl', 'chmod 0660 /var/lib/treeseed/manager/events.jsonl']) expect(postinst).toContain(contract);
		expect(readFileSync(resolve(process.cwd(), 'src/core/events.ts'), 'utf8')).toContain('mode: 0o660');
	});

	it('serializes reset with reconciliation and resolves the packaged API alias', () => {
		expect(serializedResetArguments().slice(0, 5)).toEqual(['--exclusive', '--close', '--wait', '3500', '/run/treeseed/manager/reconcile.lock']);
		const configuration = host(), releases = [component('api', 'stable', 'b')];
		expect(managedCliControlPlaneUrl(configuration, releases)).toBe('https://api.treeseed.localhost');
		configuration.components.api!.aliases['api.service.http'] = 'control.treeseed.localhost';
		expect(managedCliControlPlaneUrl(configuration, releases)).toBe('https://control.treeseed.localhost');
	});

	it('activates Compose with only the manager-rendered component environment', () => {
		const calls: Array<[string, readonly string[]]> = [];
		executeSupervisorOperation({ operation: 'compose.activate', componentId: 'agent', files: ['agent/0.13.0~rc12/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 120 }, (executable, arguments_) => (calls.push([executable, arguments_]), arguments_.includes('enroll') ? JSON.stringify({ ok: true, identities: [] }) : undefined));
		const activation = calls.find(([, arguments_]) => arguments_[0] === 'compose');
		expect(activation).toEqual(['/usr/bin/docker', ['compose', '--env-file', '/etc/treeseed/components/agent/environment', '--file', '/usr/share/treeseed/components/agent/0.13.0~rc12/compose.yml', '--project-name', 'treeseed-agent', 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '120']]);
		expect(JSON.stringify(calls)).not.toContain('process.env');
	});

	it('hands provider enrollment to the fixed packaged Agent entrypoint without token arguments', () => {
		const calls: Array<{ executable: string; arguments: readonly string[]; input: string | undefined }> = [];
		const result = executeSupervisorOperation({ operation: 'provider.enrollment-handoff', payload: { action: 'begin', connectionId: 'local-team', teamId: 'team-id', controlPlaneUrl: 'http://api:3000', controlPlaneAudience: 'https://api.treeseed.localhost', enrollmentToken: 'one-time-secret' }, files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' }, (executable, arguments_, input) => {
			calls.push({ executable, arguments: arguments_, input });
			return JSON.stringify({ ok: true, connectionId: 'local-team', state: 'pending-approval', requestId: 'request-123' });
		});
		expect(result).toEqual({ ok: true, connectionId: 'local-team', state: 'pending-approval', requestId: 'request-123' });
		expect(calls[0]?.arguments).toEqual(['compose', '--env-file', '/etc/treeseed/components/agent/environment', '--file', '/usr/share/treeseed/components/agent/release/compose.yml', '--project-name', 'treeseed-agent', 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json']);
		expect(calls[0]?.arguments.join(' ')).not.toContain('one-time-secret');
		expect(JSON.parse(calls[0]!.input!)).toMatchObject({ action: 'begin', connectionId: 'local-team', enrollmentToken: 'one-time-secret' });
	});

	it('accepts only bounded host commands and fixed configuration or enrollment mutations', () => {
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.host.component.enable', arguments: ['agent'], options: { plan: true } })).toMatchObject({ handlerId: 'local.host.component.enable' });
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.dev.session.start', options: { payload: '{}' } })).toMatchObject({ handlerId: 'local.dev.session.start' });
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.dev.host.guest-image.import', options: { payload: '{}' } })).toMatchObject({ handlerId: 'local.dev.host.guest-image.import' });
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'remote.shell', arguments: ['id'] })).toThrow();
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'local.shell.execute', arguments: ['id'] })).toThrow();
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.host.reset', options: { confirm: true } })).toMatchObject({ handlerId: 'local.host.reset', options: { confirm: true } });
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'local.host.status', arguments: ['x'.repeat(257)] })).toThrow();
		expect(developmentEnvironmentPayloadSchema.parse({ sessionId: 'dev-1', projectId: 'admin', targetId: 'web' })).toEqual({ sessionId: 'dev-1', projectId: 'admin', targetId: 'web' });
		expect(() => developmentEnvironmentPayloadSchema.parse({ sessionId: 'dev-1', projectId: 'admin' })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'configuration.replace', configuration: host() })).toMatchObject({ operation: 'configuration.replace' });
		expect(supervisorOperationSchema.parse({ operation: 'configuration.recover', configuration: host() })).toMatchObject({ operation: 'configuration.recover' });
		expect(supervisorOperationSchema.parse({ operation: 'pki.enroll', clientId: 'client-12345678' })).toEqual({ operation: 'pki.enroll', clientId: 'client-12345678' });
		expect(() => supervisorOperationSchema.parse({ operation: 'pki.enroll', clientId: '../../root' })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'component.configure', componentId: 'api', connectionEnvironment: {} })).toEqual({ operation: 'component.configure', componentId: 'api', connectionEnvironment: {} });
		expect(supervisorOperationSchema.parse({ operation: 'provider.enroll', connectionId: 'primary', teamId: 'team:treeseed', controlPlaneUrl: 'https://api.example.test', controlPlaneAudience: 'https://api.example.test', registrationSecretId: 'provider-registration', offer: { maxConcurrentRunners: 4, capabilities: ['agent-execution'] }, files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' })).toMatchObject({ operation: 'provider.enroll', connectionId: 'primary' });
		expect(() => supervisorOperationSchema.parse({ operation: 'provider.enroll', connectionId: 'primary', teamId: 'team', controlPlaneUrl: 'http://api', controlPlaneAudience: 'http://api', registrationSecretId: '../token', offer: { maxConcurrentRunners: 1, capabilities: [] }, files: ['compose.yml'], projectName: 'treeseed-agent' })).toThrow();
		expect(() => supervisorOperationSchema.parse({ operation: 'component.configure', componentId: '../api' })).toThrow();
		const supervisor = readFileSync(resolve(process.cwd(), 'src/supervisor/execute.ts'), 'utf8');
		expect(supervisor).toContain("'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'");
		expect(supervisor).toContain('unlinkSync(secretPath)');
	});

	it('recovers only an invalid configuration without decoding the old bytes', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-config-recovery-')), configurationPath = resolve(root, 'platform.json'), archiveRoot = resolve(root, 'invalid');
		writeFileSync(configurationPath, '{"obsolete":true}\n');
		expect(tryLoadHostConfiguration(configurationPath)).toBeUndefined();
		const result = recoverInvalidConfiguration({ operation: 'configuration.recover', configuration: host() }, configurationPath, archiveRoot);
		expect(readFileSync(result.archive, 'utf8')).toBe('{"obsolete":true}\n');
		expect(tryLoadHostConfiguration(configurationPath)).toEqual(host());
		expect(() => recoverInvalidConfiguration({ operation: 'configuration.recover', configuration: host() }, configurationPath, archiveRoot)).toThrow(/only available when/u);
		const api = readFileSync(resolve(process.cwd(), 'src/manager/api.ts'), 'utf8');
		expect(api).toContain('remote: undefined');
		expect(api).toContain('recoveryRequired: !host');
	});

	it('quarantines obsolete manager state without decoding an old format', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-state-recovery-')), invalidRoot = resolve(root, 'invalid');
		const receiptPath = resolve(root, 'current-receipt.json'), componentsPath = resolve(root, 'active-components.json');
		writeFileSync(receiptPath, '{"schemaVersion":"obsolete.receipt/v0"}\n');
		writeFileSync(componentsPath, '{"obsolete":true}\n');
		expect(loadCurrentReceipt(receiptPath, invalidRoot, () => undefined)).toBeUndefined();
		expect(loadActiveComponents(componentsPath, invalidRoot, () => undefined)).toEqual([]);
		expect(existsSync(receiptPath)).toBe(false);
		expect(existsSync(componentsPath)).toBe(false);
		const archived = readdirSync(invalidRoot).sort();
		expect(archived).toHaveLength(2);
		expect(archived.every((name) => name.endsWith('.invalid'))).toBe(true);
	});

	it('renders deterministic component environments without embedding secret references', () => {
		const configuration = host();
		configuration.components.api!.configuration = { environment: { TREESEED_ENVIRONMENT: 'local', TREESEED_API_BASE_URL: 'https://api.treeseed.localhost' } };
		expect(renderComponentEnvironment(configuration, 'api')).toBe('TREESEED_API_BASE_URL="https://api.treeseed.localhost"\nTREESEED_ENVIRONMENT="local"\n');
		expect(() => renderComponentEnvironment({ ...configuration, components: { api: { ...configuration.components.api!, configuration: { environment: { bad: 'value' } } } } }, 'api')).toThrow(/Invalid environment/u);
	});

	it('resolves only the component secret mapping declared for a development target', () => {
		const configuration = host();
		configuration.components.api!.configuration = { environment: { TREESEED_SITE_URL: 'https://admin.treeseed.localhost' }, secretEnvironment: { TREESEED_DATABASE_URL: 'api-database-url', TREESEED_OTHER_TOKEN: 'agent-token' } };
		configuration.secrets['api-database-url'] = { provider: 'file', reference: '/etc/treeseed/credentials/api-database-url' };
		configuration.secrets['agent-token'] = { provider: 'file', reference: '/etc/treeseed/credentials/agent-token' };
		const requested = { TREESEED_DATABASE_URL: 'api-database-url' };
		expect(resolveDevelopmentSecretEnvironment(configuration, 'api', requested, { TREESEED_API_BASE_URL: 'https://api.treeseed.localhost' }, (path) => {
			expect(path).toBe('/etc/treeseed/credentials/api-database-url');
			return 'postgresql://local\n';
		})).toEqual({ TREESEED_API_BASE_URL: 'https://api.treeseed.localhost', TREESEED_SITE_URL: 'https://admin.treeseed.localhost', TREESEED_DATABASE_URL: 'postgresql://local' });
		expect(() => resolveDevelopmentSecretEnvironment(configuration, 'api', { TREESEED_DATABASE_URL: 'agent-token' }, {}, () => 'secret')).toThrow(/not configured/u);
		expect(() => resolveDevelopmentSecretEnvironment(configuration, 'api', { TREESEED_UNDECLARED_TOKEN: 'agent-token' }, {}, () => 'secret')).toThrow(/not configured/u);
	});

	it('places development state under the workspace-visible data root', () => {
		const configuration = host();
		configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/work/platform/.treeseed/data' };
		expect(componentStateRoot(configuration, 'treedx')).toBe('/work/platform/.treeseed/data/treedx');
		expect(renderComponentEnvironment(configuration, 'api')).toContain('TREESEED_COMPONENT_DATA_ROOT="/work/platform/.treeseed/data"');
		expect(renderComponentEnvironment(configuration, 'api')).toContain('TREESEED_ENVIRONMENT="local"');
		expect(renderComponentEnvironment(configuration, 'api')).toContain('TREESEED_LOCAL_DEV_MODE="1"');
	});

	it('creates the state roots declared by the three TreeAI components', () => {
		expect(componentStateDirectories('ai-inference')).toEqual(['data/postgres', 'data/models', 'data/inference']);
		expect(componentStateDirectories('ai-training')).toEqual(['data/postgres', 'data/training', 'data/archive', 'data/models']);
		expect(componentStateDirectories('ai-lab')).toEqual(['data/state', 'data/hermes', 'data/workspace', 'data/open-webui']);
		expect(() => componentStateDirectories('ai')).toThrow(/Unsupported configured component/u);
	});

	it('polls development every minute and gates stable activation to Sunday 03:00', () => {
		const configuration = host();
		expect(pollIntervalSeconds(configuration, 'development')).toBe(60);
		expect(pollIntervalSeconds(configuration, 'stable')).toBe(86_400);
		const sunday = new Date(2026, 7, 23, 3, 0), window = stableActivationWindow(configuration, sunday);
		expect(window.startsAt).toEqual(sunday);
		expect(window.jitterSeconds).toBeGreaterThanOrEqual(0);
		expect(window.jitterSeconds).toBeLessThanOrEqual(1_800);
		expect(activationEligible(configuration, 'stable', new Date(window.eligibleAt.getTime() - 1))).toBe(false);
		expect(activationEligible(configuration, 'stable', window.eligibleAt)).toBe(true);
		expect(activationEligible(configuration, 'stable', new Date(window.closesAt.getTime() - 1))).toBe(true);
		expect(activationEligible(configuration, 'stable', window.closesAt)).toBe(false);
		expect(activationEligible(configuration, 'stable', new Date(2026, 7, 24, 3, 10))).toBe(false);
		expect(activationEligible(configuration, 'development')).toBe(true);
		expect(stableActivationWindow(configuration, new Date(2026, 7, 30, 3, 0)).startsAt).toEqual(new Date(2026, 7, 30, 3, 0));
	});

	it('refreshes stable metadata only when its persisted cadence is due', () => {
		const configuration = host(), checkedAt = new Date('2026-08-24T12:00:00.000Z');
		const state = { stablePaused: false, developmentPaused: false, developmentPauseOwners: [], changedAt: checkedAt.toISOString(), metadataCheckedAt: { stable: checkedAt.toISOString(), development: null } };
		expect(metadataRefreshDue(configuration, 'stable', state, new Date('2026-08-25T11:59:59.999Z'))).toBe(false);
		expect(metadataRefreshDue(configuration, 'stable', state, new Date('2026-08-25T12:00:00.000Z'))).toBe(true);
		expect(metadataRefreshDue(configuration, 'development', state, checkedAt)).toBe(true);
	});

	it('refreshes both catalogs from the development suite on a development-default host', () => {
		expect(aptSuiteForRefresh('development', 'stable')).toBe('development');
		expect(aptSuiteForRefresh('development', 'development')).toBe('development');
		expect(aptSuiteForRefresh('stable', 'stable')).toBe('stable');
		expect(aptSuiteForRefresh('stable', 'development')).toBe('development');
	});

	it('selects an explicit update track without silently falling back to stable', () => {
		expect(updateTrack({ arguments: ['development'], options: {} })).toBe('development');
		expect(updateTrack({ arguments: [], options: { track: 'development' } })).toBe('development');
		expect(updateTrack({ arguments: [], options: {} })).toBe('stable');
		expect(() => updateTrack({ arguments: ['nightly'], options: {} })).toThrow(/stable or development/u);
	});

	it('selects archive-qualified packages when track versions cross', () => {
		expect(packageFromTrack('treeseed-release-catalog', 'development')).toBe('treeseed-release-catalog/development');
		expect(packageFromTrack('treeseed-manager', 'stable')).toBe('treeseed-manager/stable');
		expect(() => packageFromTrack('../manager', 'stable')).toThrow(/invalid/u);
		expect(catalogPackagesForTrack('stable')).toEqual(['treeseed-release-catalog/stable']);
		expect(catalogPackagesForTrack('development')).toEqual(['treeseed-release-catalog-development/development']);
		expect(corePackagesForTrack('development', { 'treeseed-edge': '0.1.0-1' })).toContain('treeseed-edge/development');
		expect(corePackagesForTrack('development', { 'treeseed-edge': null })).not.toContain('treeseed-edge/development');
		const bootstrap = readFileSync(resolve(process.cwd(), 'scripts/bootstrap/bootstrap.sh'), 'utf8');
		expect(bootstrap).toContain('$package/$suite');
		expect(bootstrap).toContain('treeseed-release-catalog-development/development');
		expect(bootstrap).toContain('--allow-downgrades');
		const aptHelper = readFileSync(resolve(process.cwd(), 'src/supervisor/apt-helper.ts'), 'utf8');
		expect(aptHelper).not.toContain("'--only-upgrade'");
		expect(aptPreferencesForTrack('development')).toContain('a=development\nPin-Priority: 1001');
		expect(aptPreferencesForTrack('development')).toContain('a=stable\nPin-Priority: 100');
		expect(aptPreferencesForTrack('stable')).toContain('a=stable\nPin-Priority: 1001');
		for (const track of ['stable', 'development'] as const) expect(readFileSync(resolve(process.cwd(), `deploy/bootstrap/preferences.${track}`), 'utf8')).toBe(aptPreferencesForTrack(track));
	});

	it('clears disposable APT archives before exact installs and downgrades', () => {
		let archiveBytes = 2_492_509_136;
		const calls: Array<{ executable: string; arguments_: readonly string[] }> = [];
		installPackages(['treeseed-component-api=0.12.49~rc48-1'], (executable, arguments_) => {
			calls.push({ executable, arguments_ });
			if (arguments_[0] === 'clean') archiveBytes = 0;
			if (arguments_.includes('install') && archiveBytes > 500_000_000) throw new Error('APT archive cache limit exceeded');
		});
		expect(calls.map(({ arguments_ }) => arguments_[0])).toEqual(['clean', '--yes']);
		expect(calls[1]!.arguments_).toContain('--allow-downgrades');
		expect(archiveBytes).toBe(0);
	});

	it('reports a newer catalog reader requirement without stranding explicit apply', () => {
		const summary = availableCatalogSummary('/stable.json', '/development.json', () => { throw new Error('older SDK rejected runtime.configuration'); }, () => true);
		expect(summary).toEqual({ compatible: false, requiresCoreUpdate: true, stable: null, development: null });
		const forced = serializedReconcileArguments(undefined, true);
		expect(forced.at(-1)).toBe('--force-metadata');
		const operations = readFileSync(resolve(process.cwd(), 'src/manager/operations.ts'), 'utf8');
		expect(operations).toContain("serializedReconcile(undefined, true)");
		const reconciliation = readFileSync(resolve(process.cwd(), 'src/manager/reconcile.ts'), 'utf8');
		expect(reconciliation).toContain('(forceMetadata || activationEligible(host, track))');
	});

	it('keeps the manager-owned edge on the host default track', () => {
		const reconciliation = readFileSync(resolve(process.cwd(), 'src/manager/reconcile.ts'), 'utf8');
		expect(reconciliation).toContain('`treeseed-edge/${host.updates.defaultTrack}`');
		expect(reconciliation).not.toContain("packages.unshift('treeseed-edge')");
	});

	it('repairs CLI endpoint and CA custody before unchanged no-op convergence', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/manager/reconcile.ts'), 'utf8');
		expect(source.indexOf("operation: 'cli.configure'")).toBeLessThan(source.indexOf("recordEvent('reconcile.noop'"));
		const supervisor = readFileSync(resolve(process.cwd(), 'src/supervisor/execute.ts'), 'utf8');
		expect(supervisor).toContain("readFileSync(`${paths.tls}/ca.crt`)");
		expect(supervisor).toContain("`${paths.cli}/localhost-ca.crt`");
	});

	it('installs selected component payloads before validating or activating them', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/manager/reconcile.ts'), 'utf8');
		const install = source.indexOf("operation: 'apt.install'"), validate = source.indexOf('validateProductionCompose(component');
		expect(install).toBeGreaterThan(0);
		expect(validate).toBeGreaterThan(install);
	});

	it('serializes bootstrap reconciliation and starts an inactive edge', () => {
		const bootstrap = readFileSync(resolve(process.cwd(), 'scripts/bootstrap/bootstrap.sh'), 'utf8');
		const stopTimers = bootstrap.indexOf('systemctl stop treeseed-manager-development.timer'), initialReconcile = bootstrap.indexOf('systemctl start treeseed-manager-reconcile.service'), startTimers = bootstrap.indexOf('systemctl start treeseed-manager-stable.timer');
		expect(stopTimers).toBeGreaterThan(0);
		expect(initialReconcile).toBeGreaterThan(stopTimers);
		expect(startTimers).toBeGreaterThan(initialReconcile);
		expect(readFileSync(resolve(process.cwd(), 'src/supervisor/execute.ts'), 'utf8')).toContain("['reload-or-restart', 'treeseed-edge.service']");
		expect(bootstrap).toContain('/usr/lib/treeseed/manager/dist/src/bin/wait-supervisor.js');
		expect(bootstrap).toContain('elif [ ! -f /etc/treeseed/platform.json ]');
		for (const unit of ['reconcile', 'development', 'stable']) expect(readFileSync(resolve(process.cwd(), `systemd/treeseed-manager-${unit}.service`), 'utf8')).toContain('/usr/bin/flock --exclusive --close --wait 3500 /run/treeseed/manager/reconcile.lock');
	});

	it('serializes API reconciliation through the same cross-process lock as systemd', () => {
		const arguments_ = serializedReconcileArguments('development');
		expect(arguments_.slice(0, 5)).toEqual(['--exclusive', '--close', '--wait', '3500', '/run/treeseed/manager/reconcile.lock']);
		expect(arguments_.at(-1)).toBe('--track=development');
		const operations = readFileSync(resolve(process.cwd(), 'src/manager/operations.ts'), 'utf8');
		expect(operations).not.toMatch(/\breconcile\(\)/u);
		expect(operations.match(/serializedReconcile\(\)/gu)?.length).toBe(6);
		expect(operations.match(/serializedReconcile\(undefined, true\)/gu)?.length).toBe(1);
	});

	it('defers manager self-restart long enough to return the accepted receipt', () => {
		const unit = readFileSync(resolve(process.cwd(), 'systemd/treeseed-manager-restart.service'), 'utf8');
		expect(unit).toContain('ExecStart=/usr/bin/sleep 5');
		expect(unit).toContain('ExecStart=/usr/bin/systemctl restart treeseed-manager-supervisor.service treeseed-manager-api.service');
	});

	it('schedules exactly one deferred restart after every post-refresh outcome', async () => {
		let restarts = 0;
		const schedule = async () => { restarts += 1; };
		await expect(withDeferredManagerRestart(true, async () => 'accepted', schedule)).resolves.toBe('accepted');
		expect(restarts).toBe(1);
		await expect(withDeferredManagerRestart(false, async () => 'unchanged', schedule)).resolves.toBe('unchanged');
		expect(restarts).toBe(1);
		const failure = new Error('planning failed');
		await expect(withDeferredManagerRestart(true, async () => { throw failure; }, schedule)).rejects.toBe(failure);
		expect(restarts).toBe(2);
		await expect(withDeferredManagerRestart(true, async () => 'accepted', async () => { throw new Error('restart unavailable'); })).resolves.toBe('accepted');
	});

	it('hands a core upgrade to the new manager without planning in the stale process', async () => {
		let operations = 0, handoffs = 0;
		const operate = async () => { operations += 1; return 'new'; };
		await expect(withCoreUpgradeHandoff(true, 'previous', operate, () => { handoffs += 1; })).resolves.toBe('previous');
		expect({ operations, handoffs }).toEqual({ operations: 0, handoffs: 1 });
		await expect(withCoreUpgradeHandoff(false, 'previous', operate, () => { handoffs += 1; })).resolves.toBe('new');
		expect({ operations, handoffs }).toEqual({ operations: 1, handoffs: 1 });
	});
});
