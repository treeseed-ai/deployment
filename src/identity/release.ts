import { createHash } from 'node:crypto';
import { componentReleaseSchema, deploymentDigest, packageRuntimeSchema } from '@treeseed/sdk/deployment';
import { IDENTITY_IMAGES, managedIdentityServices } from './compose.js';

/** Thin immutable upstream-service bundle, published by Deployment, not Identity npm. */
export function identityComponentBundle(applicationVersion: string, commit: string) {
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(applicationVersion) || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Exact Identity component release required');
  const release = `${applicationVersion.replace(/-rc\.(\d+)$/u, '~rc$1')}-1`;
  const publicUrl = 'https://identity.treeseed.localhost', configurationRoot = '/run/treeseed/identity';
  const [taggedRepository, digest] = IDENTITY_IMAGES.keycloak.split('@');
  const repository = taggedRepository!.replace(/:[^/]+$/u, '');
  const service = (phase: 'migration' | 'runtime') => {
    const runtime = managedIdentityServices({ publicUrl, configurationRoot, database: { allocationRoot: '/run/treeseed/postgres/identity' }, databasePhase: phase }).identity;
    return { ...runtime, image: `${repository}@${digest}`, env_file: '/etc/treeseed/components/identity/environment',
      environment: { ...runtime.environment, KC_HOSTNAME: '${TREESEED_IDENTITY_PUBLIC_URL:-https://identity.treeseed.localhost}' },
      networks: phase === 'migration' ? ['private', 'database'] : ['private', 'database', 'edge'],
      volumes: [...runtime.volumes, { type: 'bind', source: `/run/treeseed/postgres-clients/identity/identity/${phase}`, target: '/run/treeseed/postgres/identity', read_only: true }] };
  };
  const migration = service('migration');
  migration.restart = 'no'; migration.command.push('--import-realm');
  migration.volumes.push({ type: 'bind', source: `${configurationRoot}/import`, target: '/opt/keycloak/data/import', read_only: true });
  const compose = `${JSON.stringify({ services: { 'identity-migration': migration, identity: service('runtime') },
    networks: { private: { internal: true }, database: { name: 'treeseed-postgres-private', external: true }, edge: { name: 'treeseed-edge', external: true } } }, null, 2)}\n`;
  const runtime = packageRuntimeSchema.parse({ schemaVersion: 'treeseed.package-runtime/v1', componentId: 'identity', version: release,
    compose: { projectName: 'treeseed-identity', files: [{ path: 'compose.yml', digest: `sha256:${createHash('sha256').update(compose).digest('hex')}` }] },
    services: [{ id: 'migration', composeService: 'identity-migration', endpoints: [] }, { id: 'identity', composeService: 'identity', endpoints: [
      { id: 'https', protocol: 'https', port: 8443, visibility: 'host', defaultAlias: 'identity.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application',
        healthGate: { protocol: 'https', path: '/realms/treeseed/.well-known/openid-configuration', timeoutSeconds: 120 } }] }],
    stateVolumes: [{ id: 'identity-os', volume: '/var/lib/treeseed/components/identity/identity-os', backup: 'required' }],
    postgresRequirements: [{ id: 'identity', supportedMajors: [17], extensions: [], runtimeConnectionLimit: 20 }],
    postgresLifecycle: [{ requirementId: 'identity', credentialOwner: { uid: 1000, gid: 0 },
      migration: { composeService: 'identity-migration', completion: 'healthy-stop', timeoutSeconds: 300 }, runtimeServices: ['identity'] }],
    migrations: [{ id: 'keycloak-schema', order: 0, backupRequired: true }], requiredCapabilities: ['docker-compose'], dependencies: [] });
  const component = componentReleaseSchema.parse({ schemaVersion: 'treeseed.component-release/v1', componentId: 'identity', release, applicationVersion, revision: 1,
    track: applicationVersion.includes('-rc.') ? 'development' : 'stable', source: { repository: 'treeseed-ai/deployment', commit },
    stableBase: applicationVersion.includes('-rc.') ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
    packages: [{ name: 'treeseed-component-identity', version: release, architecture: 'all', origin: 'TreeSeed Deployment', order: 40 }],
    images: [{ role: 'identity', repository, digest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['identity'] }],
    runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
    evidence: { provenance: [`https://github.com/treeseed-ai/deployment/commit/${commit}`], sboms: [], vulnerabilities: [] } });
  return { component, compose };
}
