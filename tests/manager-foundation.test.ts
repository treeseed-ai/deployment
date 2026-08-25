import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activationEligible, aptPreferencesForTrack, catalogPackagesForTrack, corePackagesForTrack, createPlan, edgeRoutes, executeSupervisorOperation, hostCommandRequestSchema, managedCliControlPlaneUrl, metadataRefreshDue, packageFromTrack, pollIntervalSeconds, recoverInvalidConfiguration, renderCaddyfile, renderComponentEnvironment, resetPlatformState, rollbackRoutes, serializedReconcileArguments, serializedResetArguments, stableActivationWindow, subjectAlternativeNames, supervisorOperationSchema, tryLoadHostConfiguration, updateTrack, validateProductionCompose, withDeferredManagerRestart } from '../src/index.js';
import { loadActiveComponents, loadCurrentReceipt } from '../src/manager/current-state.js';
import { catalogs, component, hash, host } from './fixtures.js';

describe('unified host manager foundation', () => {
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
		expect(supervisorOperationSchema.parse({ operation: 'manager.restart' })).toEqual({ operation: 'manager.restart' });
		expect(supervisorOperationSchema.parse({ operation: 'supervisor.ping' })).toEqual({ operation: 'supervisor.ping' });
		expect(supervisorOperationSchema.parse({ operation: 'component.reset-unaccepted', componentId: 'api' })).toEqual({ operation: 'component.reset-unaccepted', componentId: 'api' });
		expect(supervisorOperationSchema.parse({ operation: 'platform.reset' })).toEqual({ operation: 'platform.reset' });
		expect(supervisorOperationSchema.parse({ operation: 'cli.configure', controlPlaneUrl: 'https://api.treeseed.localhost' })).toEqual({ operation: 'cli.configure', controlPlaneUrl: 'https://api.treeseed.localhost' });
		expect(() => supervisorOperationSchema.parse({ operation: 'cli.configure', controlPlaneUrl: 'http://api.example.test' })).toThrow();
		executeSupervisorOperation({ operation: 'manager.restart' }, (executable, arguments_) => calls.push([executable, arguments_]));
		expect(calls.at(-1)).toEqual(['/usr/bin/systemctl', ['--no-block', 'start', 'treeseed-manager-restart.service']]);
		expect(() => supervisorOperationSchema.parse({ operation: 'apt.refresh', track: 'nightly', updateCore: true })).toThrow();
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

	it('returns reset manager state to the unprivileged manager account', () => {
		const supervisor = readFileSync(resolve(process.cwd(), 'src/supervisor/execute.ts'), 'utf8');
		const postinst = readFileSync(resolve(process.cwd(), 'debian/manager/postinst'), 'utf8');
		expect(supervisor.indexOf("writeFileSync(`${paths.managerState}/events.jsonl`, ''")).toBeLessThan(supervisor.indexOf("command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState])"));
		expect(supervisor).toContain("command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState])");
		expect(postinst).toContain('chown -R treeseed-manager:treeseed-manager /var/lib/treeseed/manager');
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
		executeSupervisorOperation({ operation: 'compose.activate', componentId: 'agent', files: ['agent/0.13.0~rc12/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 120 }, (executable, arguments_) => calls.push([executable, arguments_]));
		const activation = calls.find(([, arguments_]) => arguments_[0] === 'compose');
		expect(activation).toEqual(['/usr/bin/docker', ['compose', '--env-file', '/etc/treeseed/components/agent/environment', '--file', '/usr/share/treeseed/components/agent/0.13.0~rc12/compose.yml', '--project-name', 'treeseed-agent', 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '120']]);
		expect(JSON.stringify(calls)).not.toContain('process.env');
	});

	it('accepts only bounded host commands and fixed configuration or enrollment mutations', () => {
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.host.component.enable', arguments: ['agent'], options: { plan: true } })).toMatchObject({ handlerId: 'local.host.component.enable' });
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'remote.shell', arguments: ['id'] })).toThrow();
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.host.reset', options: { confirm: true } })).toMatchObject({ handlerId: 'local.host.reset', options: { confirm: true } });
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'local.host.status', arguments: ['x'.repeat(257)] })).toThrow();
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
		const state = { stablePaused: false, developmentPaused: false, changedAt: checkedAt.toISOString(), metadataCheckedAt: { stable: checkedAt.toISOString(), development: null } };
		expect(metadataRefreshDue(configuration, 'stable', state, new Date('2026-08-25T11:59:59.999Z'))).toBe(false);
		expect(metadataRefreshDue(configuration, 'stable', state, new Date('2026-08-25T12:00:00.000Z'))).toBe(true);
		expect(metadataRefreshDue(configuration, 'development', state, checkedAt)).toBe(true);
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
		expect(catalogPackagesForTrack('development')).toEqual(['treeseed-release-catalog/development', 'treeseed-release-catalog-development/development']);
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
});
