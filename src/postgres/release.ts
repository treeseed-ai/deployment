import { createHash } from 'node:crypto';
import { componentReleaseSchema, deploymentDigest, packageRuntimeSchema } from '@treeseed/sdk/deployment';
import { managedPostgresService, POSTGRES_IMAGE } from './compose.js';

/** No image build: pin the same upstream image exercised by disposable acceptance. */
export function postgresComponentBundle(applicationVersion: string, commit: string) {
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(applicationVersion) || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Exact PostgreSQL component release identity required');
  const release = `${applicationVersion.replace(/-rc\.(\d+)$/u, '~rc$1')}-1`;
  const digest = POSTGRES_IMAGE.split('@')[1]!;
  const service = managedPostgresService({ configurationRoot: '/run/treeseed/postgres', stateRoot: '/var/lib/treeseed/components/postgres' });
  service.image = `postgres@${digest}`;
  service.volumes = service.volumes.map(volume => ({ ...volume,
    source: volume.source.replace('/var/lib/treeseed/components', '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}') }));
  const compose = `${JSON.stringify({ services: { postgres: service }, networks: { private: { name: 'treeseed-postgres-private', internal: true } } }, null, 2)}\n`;
  const runtime = packageRuntimeSchema.parse({ schemaVersion: 'treeseed.package-runtime/v1', componentId: 'postgres', version: release,
    compose: { projectName: 'treeseed-postgres', files: [{ path: 'compose.yml', digest: `sha256:${createHash('sha256').update(compose).digest('hex')}` }] },
    services: [{ id: 'postgres', composeService: 'postgres', endpoints: [{ id: 'database', protocol: 'tcp', port: 5432,
      visibility: 'private', aliasOverride: false, tls: 'passthrough', authentication: 'application' }] }],
    stateVolumes: ['postgres', 'postgres-os', 'lifecycle'].map(id => ({ id, volume: `/var/lib/treeseed/components/postgres/${id}`, backup: 'required' })),
    migrations: [], requiredCapabilities: ['docker-compose'], dependencies: [] });
  const component = componentReleaseSchema.parse({ schemaVersion: 'treeseed.component-release/v1', componentId: 'postgres', release,
    applicationVersion, revision: 1, track: applicationVersion.includes('-rc.') ? 'development' : 'stable',
    source: { repository: 'treeseed-ai/deployment', commit }, stableBase: applicationVersion.includes('-rc.') ?
      { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
    packages: [{ name: 'treeseed-postgres', version: release, architecture: 'all', origin: 'TreeSeed Deployment', order: 30 }],
    images: [{ role: 'postgres', repository: 'postgres', digest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['postgres'] }],
    runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
    evidence: { provenance: [`https://github.com/treeseed-ai/deployment/commit/${commit}`], sboms: [], vulnerabilities: [] } });
  return { component, compose };
}
