import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activationEligible, createPlan, edgeRoutes, executeSupervisorOperation, hostCommandRequestSchema, pollIntervalSeconds, renderCaddyfile, renderComponentEnvironment, subjectAlternativeNames, supervisorOperationSchema, validateProductionCompose } from '../src/index.js';
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
		configuration.components.api!.aliases = { 'api.http': 'api-canary.treeseed.localhost' };
		expect(() => createPlan(configuration, stable, development)).toThrow(/does not identify an accepted host endpoint/u);
		configuration.components.api!.aliases = { 'api.service.http': 'api-canary.treeseed.localhost' };
		expect(createPlan(configuration, stable, development).routes.map((route) => route.alias)).toContain('api-canary.treeseed.localhost');
	});

	it('renders one certificate identity set and mTLS manager policy', () => {
		const routes = [...edgeRoutes([component('api', 'stable', 'b')]), { alias: 'manager.treeseed.localhost', upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' as const }];
		const caddyfile = renderCaddyfile(routes);
		expect(subjectAlternativeNames(routes)).toEqual(['api.treeseed.localhost', 'manager.treeseed.localhost']);
		expect(caddyfile).toContain('mode require_and_verify');
		expect(caddyfile).toContain('reverse_proxy unix//run/treeseed/manager/api.sock');
	});

	it('rejects source builds, mutable images, and host port publication', () => {
		const release = component('api', 'stable', 'b'), root = mkdtempSync(resolve(tmpdir(), 'treeseed-compose-'));
		const file = resolve(root, 'compose.yml');
		writeFileSync(file, `services:\n  service:\n    image: treeseed/api@${hash('b')}\n`);
		expect(() => validateProductionCompose(release, root)).not.toThrow();
		writeFileSync(file, `services:\n  service:\n    build: .\n    image: treeseed/api@${hash('b')}\n`);
		expect(() => validateProductionCompose(release, root)).toThrow(/forbidden Compose build/u);
		writeFileSync(file, 'services:\n  service:\n    image: treeseed/api:latest\n');
		expect(() => validateProductionCompose(release, root)).toThrow(/immutable image digest/u);
		writeFileSync(file, `services:\n  service:\n    image: treeseed/api@${hash('b')}\n    ports: ["3000:3000"]\n`);
		expect(() => validateProductionCompose(release, root)).toThrow(/publishes a host port/u);
	});

	it('keeps root execution within the fixed protocol', () => {
		const calls: Array<[string, readonly string[]]> = [];
		executeSupervisorOperation({ operation: 'systemd.control', unit: 'treeseed-edge.service', action: 'reload' }, (executable, arguments_) => calls.push([executable, arguments_]));
		expect(calls).toEqual([['/usr/bin/systemctl', ['reload', 'treeseed-edge.service']]]);
		expect(() => executeSupervisorOperation({ operation: 'systemd.control', unit: 'ssh.service', action: 'restart' }, () => undefined)).toThrow();
		expect(() => executeSupervisorOperation({ operation: 'shell', command: 'id' }, () => undefined)).toThrow();
	});

	it('activates Compose with only the manager-rendered component environment', () => {
		const calls: Array<[string, readonly string[]]> = [];
		executeSupervisorOperation({ operation: 'compose.activate', componentId: 'agent', files: ['agent/0.13.0~rc12/compose.yml'], projectName: 'treeseed-agent' }, (executable, arguments_) => calls.push([executable, arguments_]));
		const activation = calls.find(([, arguments_]) => arguments_[0] === 'compose');
		expect(activation).toEqual(['/usr/bin/docker', ['compose', '--env-file', '/etc/treeseed/components/agent/environment', '--file', '/usr/share/treeseed/components/agent/0.13.0~rc12/compose.yml', '--project-name', 'treeseed-agent', 'up', '--detach', '--remove-orphans', '--wait']]);
		expect(JSON.stringify(calls)).not.toContain('process.env');
	});

	it('accepts only bounded host commands and fixed configuration or enrollment mutations', () => {
		expect(hostCommandRequestSchema.parse({ handlerId: 'local.host.component.enable', arguments: ['agent'], options: { plan: true } })).toMatchObject({ handlerId: 'local.host.component.enable' });
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'remote.shell', arguments: ['id'] })).toThrow();
		expect(() => hostCommandRequestSchema.parse({ handlerId: 'local.host.status', arguments: ['x'.repeat(257)] })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'configuration.replace', configuration: host() })).toMatchObject({ operation: 'configuration.replace' });
		expect(supervisorOperationSchema.parse({ operation: 'pki.enroll', clientId: 'client-12345678' })).toEqual({ operation: 'pki.enroll', clientId: 'client-12345678' });
		expect(() => supervisorOperationSchema.parse({ operation: 'pki.enroll', clientId: '../../root' })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'component.configure', componentId: 'api' })).toEqual({ operation: 'component.configure', componentId: 'api' });
		expect(() => supervisorOperationSchema.parse({ operation: 'component.configure', componentId: '../api' })).toThrow();
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
		expect(activationEligible(configuration, 'stable', new Date(2026, 7, 23, 3, 10))).toBe(true);
		expect(activationEligible(configuration, 'stable', new Date(2026, 7, 24, 3, 10))).toBe(false);
		expect(activationEligible(configuration, 'development')).toBe(true);
	});
});
