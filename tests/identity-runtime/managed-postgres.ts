import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { deploymentDigest, postgresTopologySchema } from '@treeseed/sdk/deployment';
import { component, host } from '../../dist/tests/fixtures.js';
import { activateLocalPostgresComponent } from '../../dist/src/supervisor/postgres-lifecycle.js';
import { postgresComponentBundle } from '../../dist/src/postgres/release.js';
import { postgresDocker } from '../../dist/src/supervisor/postgres-process.js';

/** Exercise the actual privileged adapter on the disposable runner only. */
export async function verifyManagedPostgres(root: string, input: unknown) {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable root acceptance required');
  const paths = ['/etc/treeseed/platform.json', '/etc/treeseed/components/acceptance', '/usr/share/treeseed/components/acceptance', '/usr/share/treeseed/components/postgres'];
  for (const path of paths) assert.equal(existsSync(path), false, 'Disposable custody must start absent');
  const topology = postgresTopologySchema.parse(input);
  topology.requirements[0]!.componentId = 'acceptance';
  const configuration = host();
  configuration.runtime.environment = 'development'; configuration.runtime.dataRoot = `${root}/.treeseed/data`;
  configuration.components = { postgres: { ...configuration.components.api! }, acceptance: { ...configuration.components.api! } };
  configuration.postgres = topology;
  for (const allocation of topology.allocations) for (const id of [allocation.migrationCredentialReference, allocation.runtimeCredentialReference]) configuration.secrets[id] = { provider: 'systemd-credential', reference: `/etc/treeseed/credentials/${id}.cred` };
  const database = postgresComponentBundle('0.1.0-rc.277', 'a'.repeat(40)).component;
  const application = component('acceptance', 'stable', 'a');
  const image = `postgres@${database.images[0]!.digest}`;
  const mount = '/run/treeseed/postgres/acceptance';
  const base = { image, user: '65532:65532', networks: ['database'], security_opt: ['no-new-privileges:true'], entrypoint: ['/bin/sh', '-ec'] };
  const volume = (phase: string) => [{ type: 'bind', source: `/run/treeseed/postgres-clients/acceptance/acceptance/${phase}`, target: mount, read_only: true }];
  const sql = (statement: string) => `psql "$(cat ${mount}/url)" -v ON_ERROR_STOP=1 -c '${statement}'`;
  const compose = JSON.stringify({ services: {
    migration: { ...base, restart: 'no', volumes: volume('migration'), command: [sql('CREATE TABLE IF NOT EXISTS lifecycle_acceptance(id integer)')] },
    runtime: { ...base, restart: 'unless-stopped', volumes: volume('runtime'), command: ['exec sleep infinity'],
      healthcheck: { test: ['CMD-SHELL', sql('SELECT count(*) FROM lifecycle_acceptance')], interval: '1s', timeout: '3s', retries: 10 } },
  }, networks: { database: { external: true, name: 'treeseed-postgres-private' } } });
  application.runtime.services = ['migration', 'runtime'].map(id => ({ id, composeService: id, endpoints: [] }));
  application.runtime.compose.files[0]!.digest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
  application.runtime.postgresRequirements = [{ id: 'acceptance', supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }];
  application.runtime.postgresLifecycle = [{ requirementId: 'acceptance', credentialOwner: { uid: 65532, gid: 65532 }, migration: { composeService: 'migration', completion: 'exit-zero', timeoutSeconds: 30 }, runtimeServices: ['runtime'] }];
  application.runtimeDigest = deploymentDigest(application.runtime);
  application.images = database.images.map(image => ({ ...image, consumers: ['acceptance'] }));
  const files = `/usr/share/treeseed/components/acceptance/${application.release}/compose.yml`;
  let installed = false;
  // GitHub's disposable image makes /usr/share world-writable. A supported
  // installed host must not; retain the production ancestor guard unchanged.
  const shareMode = lstatSync('/usr/share').mode & 0o777;
  assert.equal(lstatSync('/usr/share').uid, 0);
  assert.equal(lstatSync('/usr/share').isSymbolicLink(), false);
  try {
    chmodSync('/usr/share', 0o755);
    for (const release of [database, application]) {
      const path = `/usr/share/treeseed/components/${release.componentId}/${release.release}/component-release.json`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 }); writeFileSync(path, JSON.stringify(release), { mode: 0o644 });
    }
    installed = true;
    mkdirSync('/etc/treeseed/components/acceptance', { recursive: true, mode: 0o755 });
    writeFileSync('/etc/treeseed/components/acceptance/environment', '', { mode: 0o600 });
    writeFileSync(files, compose, { mode: 0o644 });
    writeFileSync('/etc/treeseed/platform.json', JSON.stringify(configuration), { mode: 0o600 });
    const selections = [database, application].map(({ componentId, release }) => ({ componentId, release }));
    assert.equal((await activateLocalPostgresComponent('acceptance', selections)).action, 'activated');
    assert.equal((await activateLocalPostgresComponent('acceptance', selections)).action, 'noop');
    assert.equal(existsSync('/run/treeseed/postgres-clients/acceptance/acceptance/migration/password'), false);
  } finally {
    chmodSync('/usr/share', shareMode);
    if (installed && existsSync(files)) await postgresDocker(['compose', '--file', files, '--project-name', application.runtime.compose.projectName, 'down', '--volumes'], 60);
    for (const path of paths) rmSync(path, { recursive: path !== '/etc/treeseed/platform.json', force: true });
    rmSync('/run/treeseed/postgres-clients/acceptance', { recursive: true, force: true });
  }
}
