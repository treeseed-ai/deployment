import { describe, expect, it } from 'vitest';
import { componentActivationInputs } from '../src/manager/reconcile.js';
import { connectionDigest, reconcilePeerConnections } from '../src/manager/development-peer-connections.js';
import { component, host } from './fixtures.js';
import { hostComponentSchema } from '@treeseed/sdk/deployment';
import { identityEndpointSchema } from '@treeseed/sdk/identity';
import { renderComponentEnvironment } from '../src/supervisor/component.js';

describe('managed development peer routing', () => {
	it('renders an HTTPS Admin Identity resource while a selected API retains its independent internal transport', () => {
		const configuration = host(), api = component('api', 'stable', 'a'), admin = component('admin', 'stable', 'b');
		configuration.runtime.environment = 'development';
		configuration.runtime.dataRoot = '/var/lib/treeseed/development';
		admin.runtime.dependencies = [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.admin = hostComponentSchema.parse({ enabled: true, track: 'stable',
			connections: { api: { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } },
			configuration: { environment: { TREESEED_IDENTITY_ISSUER: 'https://identity.treeseed.localhost/realms/treeseed' } } });
		for (const upstream of ['http://api-live:3000', 'http://host.docker.internal:3100']) {
			const inputs = componentActivationInputs(configuration, admin, [api, admin], [{ alias: 'api.treeseed.localhost', upstream, authentication: 'application', projectId: 'api', targetId: 'service' }]);
			const environment = Object.fromEntries(renderComponentEnvironment(configuration, 'admin', inputs.connectionEnvironment).trim().split('\n').map(line => {
				const separator = line.indexOf('='); return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
			}));
			expect(identityEndpointSchema.parse(environment.TREESEED_API_BASE_URL)).toBe('https://api.treeseed.localhost');
			expect(environment.TREESEED_API_URL).toBe(upstream);
			expect(environment.TREESEED_API_HOSTNAME).toBe('api.treeseed.localhost');
			expect(environment.TREESEED_IDENTITY_HOSTNAME).toBe('identity.treeseed.localhost');
		}
	});
	it('selects and restores local API routes without changing audience or remote/production connections', () => {
		const configuration = host(), api = component('api', 'stable', 'a'), treedx = component('treedx', 'development', 'b');
		configuration.runtime.environment = 'development';
		treedx.runtime.dependencies = [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }];
		configuration.components.treedx = { enabled: true, track: 'development', aliases: {}, connections: { 'control-plane': { kind: 'local', componentId: 'api', serviceId: 'service', endpointId: 'http' } }, configuration: {} } as any;
		const routes = [{ alias: 'api.treeseed.localhost', upstream: 'http://api-live:3000', authentication: 'application' as const }];
		const inputs = () => componentActivationInputs(configuration, treedx, [api, treedx], routes).connectionEnvironment;
		expect(inputs()).toMatchObject({ TREESEED_CONTROL_PLANE_URL: 'http://api-live:3000', TREESEED_CONTROL_PLANE_AUDIENCE: 'https://api.treeseed.localhost' });
		expect(componentActivationInputs(configuration, treedx, [api, treedx]).connectionEnvironment.TREESEED_CONTROL_PLANE_URL).toBe('http://service:3000');
		configuration.runtime.environment = 'production';
		expect(inputs().TREESEED_CONTROL_PLANE_URL).toBe('http://service:3000');
		configuration.runtime.environment = 'development';
		configuration.components.treedx!.connections['control-plane'] = { kind: 'remote', url: 'https://remote.example.test', audience: 'https://remote.example.test', tls: { trust: 'system' }, authentication: { mode: 'none' }, healthGate: { protocol: 'http', path: '/ready', timeoutSeconds: 30 } };
		expect(inputs().TREESEED_CONTROL_PLANE_URL).toBe('https://remote.example.test');
	});
	it('changes only affected released peers, repeats noop, and restores when routes disappear', async () => {
		const receipts = new Map<string, string>(), activations: string[] = [];
		const peers = [
			{ componentId: 'treedx', released: { URL: 'released' }, desired: { URL: 'live' } },
			{ componentId: 'api', released: { URL: 'released' }, desired: { URL: 'live' } },
			{ componentId: 'other', released: { URL: 'same' }, desired: { URL: 'same' } },
		];
		const operations = { read: (id: string) => receipts.get(id), activate: async (id: string) => {
			activations.push(id); receipts.set(id, connectionDigest(peers.find(peer => peer.componentId === id)!.desired));
		} };
		const run = () => reconcilePeerConnections(peers, new Set(['api']), operations);
		expect(await run()).toEqual(['treedx']);
		expect(await run()).toEqual([]);
		peers[0]!.desired = peers[0]!.released;
		expect(await run()).toEqual(['treedx']);
		expect(await run()).toEqual([]);
		expect(activations).toEqual(['treedx', 'treedx']);
	});
	it('does not report a failed activation as accepted', async () => {
		await expect(reconcilePeerConnections([{ componentId: 'treedx', released: {}, desired: { URL: 'live' } }], new Set(), {
			read: () => undefined, activate: async () => { throw new Error('unhealthy'); },
		})).rejects.toThrow('unhealthy');
	});
	it('does not churn on environment ordering', () => {
		expect(connectionDigest({ A: 'one', B: 'two' })).toBe(connectionDigest({ B: 'two', A: 'one' }));
	});
});
