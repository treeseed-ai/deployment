import { componentReleaseSchema, hostConfigurationSchema, type ComponentRelease, type HostConfiguration, type ReleaseCatalog } from '@treeseed/sdk/deployment';

export const hash = (marker: string) => `sha256:${marker.repeat(64)}`;

export function component(componentId: string, track: 'stable' | 'development', marker: string, alias = `${componentId}.treeseed.localhost`): ComponentRelease {
	const version = track === 'stable' ? '1.0.0' : '1.1.0~rc1';
	return componentReleaseSchema.parse({
		schemaVersion: 'treeseed.component-release/v1', componentId, release: version, applicationVersion: version, revision: 1, track,
		source: { repository: `treeseed-ai/${componentId}`, commit: marker.repeat(40) },
		stableBase: track === 'development' ? { releaseRange: '^1.0.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('a') } : null,
		packages: [{ name: `treeseed-component-${componentId}`, version, architecture: 'all', origin: 'TreeSeed Deployment', order: 10 }],
		images: [{ role: `${componentId}-service`, repository: `treeseed/${componentId}`, digest: hash(marker), platforms: ['linux/amd64', 'linux/arm64'], consumers: [componentId] }],
		runtime: { schemaVersion: 'treeseed.package-runtime/v1', componentId, version, compose: { projectName: `treeseed-${componentId}`, files: [{ path: 'compose.yml', digest: hash('f') }] }, services: [{ id: 'service', composeService: 'service', endpoints: [{ id: 'http', protocol: 'http', port: 3000, visibility: 'host', defaultAlias: alias, aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/healthz', timeoutSeconds: 30 } }] }], stateVolumes: [], migrations: [], requiredCapabilities: ['docker-compose'], dependencies: [] },
		runtimeDigest: hash(marker), rollback: { compatible: true, requiresBackup: false }, evidence: { provenance: [], sboms: [], vulnerabilities: [] },
	});
}

export function host(): HostConfiguration {
	return hostConfigurationSchema.parse({
		schemaVersion: 'treeseed.host/v1', configurationId: 'test-host', generation: 1,
		host: { id: 'test-host', role: 'integrated', architecture: 'amd64' }, runtime: { management: 'managed', environment: 'production' },
		updates: { defaultTrack: 'stable', stable: { metadataPollSeconds: 86_400, maintenanceWindow: { weekday: 'sunday', localTime: '03:00', jitterMinutes: 30 } }, development: { pollSeconds: 60 } },
		components: { api: { enabled: true, track: 'stable', aliases: {}, configuration: {} }, agent: { enabled: true, track: 'development', aliases: {}, configuration: {} } },
		network: { manager: { binding: '0.0.0.0:4790', aliases: ['manager.treeseed.localhost'], sans: ['manager.treeseed.localhost'], trustedLanCidrs: [] } },
		fleet: { rolloutGroup: 'development-workstation', receiptReporting: { enabled: false, intervalSeconds: 300 } }, secrets: {},
	});
}

export function catalogs() {
	const stable: ReleaseCatalog = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.0.0', generation: 1, track: 'stable', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('a'), stableBase: null, components: [component('api', 'stable', 'b')], createdAt: '2026-08-23T00:00:00.000Z' };
	const development: ReleaseCatalog = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.1.0~rc1', generation: 2, track: 'development', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('d'), stableBase: { release: stable.release, catalogDigest: stable.catalogDigest }, components: [component('agent', 'development', 'c')], createdAt: '2026-08-23T00:00:00.000Z' };
	return { stable, development };
}
