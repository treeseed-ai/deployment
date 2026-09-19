import { describe, expect, it } from 'vitest';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { setComponentEnabled } from '../src/manager/component-selection.js';
import { host } from './fixtures.js';

describe('component activation', () => {
	function configuredHost() {
		const configuration = host();
		configuration.components.postgres = { enabled: true, track: 'stable', aliases: {}, configuration: {}, resources: { gpuDevices: [] }, connections: {} };
		configuration.postgres = {
			schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
			servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17,
				extensions: [], tls: { mode: 'verify-full', trustReference: 'postgres-ca' } }],
			requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
			allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator',
				runtimeRole: 'api_runtime', migrationCredentialReference: 'api-migration', runtimeCredentialReference: 'api-runtime', onDisable: 'preserve' }],
		};
		configuration.secrets['api-migration'] = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/api-migration.cred' };
		configuration.secrets['api-runtime'] = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/api-runtime.cred' };
		return hostConfigurationSchema.parse(configuration);
	}

	it('keeps one database requirement aligned across disable and re-enable without deleting its allocation', () => {
		const configuration = configuredHost(), allocation = structuredClone(configuration.postgres!.allocations);
		setComponentEnabled(configuration, 'api', false);
		expect(configuration.postgres!.requirements[0]!.enabled).toBe(false);
		expect(hostConfigurationSchema.safeParse(configuration).success).toBe(true);
		expect(configuration.postgres!.allocations).toEqual(allocation);
		setComponentEnabled(configuration, 'api', true);
		expect(configuration.postgres!.requirements[0]!.enabled).toBe(true);
		expect(hostConfigurationSchema.safeParse(configuration).success).toBe(true);
	});

	it('does not change unrelated database requirements for a component without one', () => {
		const configuration = configuredHost();
		setComponentEnabled(configuration, 'agent', false);
		expect(configuration.postgres!.requirements[0]!.enabled).toBe(true);
		expect(hostConfigurationSchema.safeParse(configuration).success).toBe(true);
		expect(() => setComponentEnabled(configuration, 'missing', false)).toThrow('Unknown configured component');
	});
});
