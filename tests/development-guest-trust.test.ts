import { describe, expect, it } from 'vitest';
import { managedConnectionEnvironment, sandboxGuestTrustDigest } from '../src/manager/reconcile.js';
import { component, host } from './fixtures.js';

describe('development sandbox guest trust', () => {
	it('does not overwrite pending development trust with an unavailable released digest', () => {
		const released = `sha256:${'a'.repeat(64)}`;
		expect(sandboxGuestTrustDigest(released, false)).toBe(released);
		expect(sandboxGuestTrustDigest(released, true)).toBeUndefined();
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
});
