import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deploymentDigest, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { component } from '../fixtures.js';
import { createGenerationBackup } from '../../dist/src/supervisor/backup.js';
import { prepareLocalPostgresTransition } from '../../dist/src/supervisor/postgres-transition-custody.js';
import { activateOrTransferPostgresComponent } from '../../dist/src/supervisor/postgres-transfer-execution.js';
import { withLocalPostgresBootstrap } from '../../dist/src/postgres/connection.js';
import { componentStateRoot } from '../../dist/src/supervisor/component.js';
import { ensureComponentCredential } from '../../dist/src/supervisor/component-sealed-write.js';
import { postgresDocker } from '../../dist/src/supervisor/postgres-process.js';

/** Full root coordinator, real OS recovery custody and unchanged source data.
 * Invoked only inside the isolated bootstrap Actions matrix. */
export async function verifyManagedTransfer(host: HostConfiguration, application: ComponentRelease, database: ComponentRelease, sourceKind: string) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.getuid?.() !== 0 || !['bookworm', 'alpine'].includes(sourceKind)) throw new Error('Disposable transfer acceptance required');
  const sourceImage = sourceKind === 'alpine'
    ? 'postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
    : 'postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825';
  const id = application.componentId, source = `treeseed-transfer-source-${randomBytes(8).toString('hex')}`;
  const data = join(componentStateRoot(host, id), 'postgres'), generation = Date.now();
  const backupKey = 'application-backup-kek-v1', keyPath = `/etc/treeseed/credentials/${backupKey}.cred`;
  const temporaryPaths = ['/var/lib/treeseed/manager/active-components.json', '/var/lib/treeseed/manager/current-receipt.json',
    '/var/lib/treeseed/manager/recovery-configuration.json', '/var/lib/treeseed/postgres-transfers', '/var/lib/treeseed/postgres-transfer-hold.json', keyPath];
  for (const path of temporaryPaths) assert.equal(existsSync(path), false, 'Disposable transition custody must start absent');
  let created = false, shared = '', stage = 'source';
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    await postgresDocker(['run', '-d', '--name', source, '--network', 'none', '--mount', `type=bind,source=${data},target=/var/lib/postgresql/data`,
      '--label', `com.docker.compose.project=${application.runtime.compose.projectName}`, '--label', 'com.docker.compose.service=database',
      '-e', 'POSTGRES_DB=application', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=en_US.utf8', sourceImage], 60);
    created = true;
    for (let i = 0; ; i++) {
      try {
        assert.equal((await postgresDocker(['exec', source, 'cat', '/proc/1/comm'], 5, true)).trim(), 'postgres');
        await postgresDocker(['exec', source, 'psql', '-X', '-U', 'postgres', '-d', 'application', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1'], 5);
        break;
      }
      catch { if (i >= 60) throw new Error('Source startup'); await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    await postgresDocker(['exec', source, 'psql', '-X', '-U', 'postgres', '-d', 'application', '-v', 'ON_ERROR_STOP=1', '-c',
      'CREATE TABLE lifecycle_acceptance(id integer); INSERT INTO lifecycle_acceptance VALUES(1),(2),(3)'], 10);
    await postgresDocker(['stop', '--time', '30', source], 40);
    const originalControl = createHash('sha256').update(readFileSync(join(data, 'global/pg_control'))).digest('hex');
    const prior = component(id, 'development', 'c');
    prior.runtime.services = [{ id: 'database', composeService: 'database', endpoints: [] }];
    prior.runtime.stateVolumes = [{ id: 'postgres', volume: `/var/lib/treeseed/components/${id}/postgres`, backup: 'required' }];
    prior.runtimeDigest = deploymentDigest(prior.runtime);
    prior.images = [{ role: 'postgres', repository: 'postgres', digest: sourceImage.split('@')[1]!, platforms: ['linux/amd64'], consumers: [id] }];
    application.runtime.stateVolumes = prior.runtime.stateVolumes;
    application.runtimeDigest = deploymentDigest(application.runtime);
    writeFileSync(`/usr/share/treeseed/components/${id}/${application.release}/component-release.json`, JSON.stringify(application), { mode: 0o644 });
    host.secrets[backupKey] = { provider: 'systemd-credential', reference: keyPath };
    ensureComponentCredential(host, backupKey, () => randomBytes(32).toString('base64url'));
    const previous = structuredClone(host); previous.postgres!.requirements = []; previous.postgres!.allocations = [];
    const next = structuredClone(host); next.generation++;
    for (const [path, value] of [
      ['/etc/treeseed/platform.json', previous], ['/var/lib/treeseed/manager/active-components.json', [database, prior]],
      ['/var/lib/treeseed/manager/current-receipt.json', { receiptId: 'fixture-known-good', configurationDigest: deploymentDigest(previous) }],
    ] as const) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
    stage = 'prepare';
    await prepareLocalPostgresTransition({ componentId: id, sourceRuntimeDigest: prior.runtimeDigest, targetRuntimeDigest: application.runtimeDigest,
      topologyDigest: deploymentDigest(next.postgres), configurationDigest: deploymentDigest(next), allowLocaleConversion: sourceKind === 'alpine' });
    shared = (await postgresDocker(['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=treeseed-postgres',
      '--filter', 'label=com.docker.compose.service=postgres'], 10, true)).trim();
    assert.match(shared, /^[a-f0-9]{64}$/u);
    await postgresDocker(['stop', '--time', '30', shared], 40);
    stage = 'backup';
    await createGenerationBackup(generation);
    writeFileSync('/etc/treeseed/platform.json', JSON.stringify(next), { mode: 0o600 });
    await postgresDocker(['start', shared], 30);
    for (let i = 0; ; i++) {
      if ((await postgresDocker(['inspect', '--format', '{{.State.Health.Status}}', shared], 5, true)).trim() === 'healthy') break;
      if (i >= 60) throw new Error('Shared startup'); await new Promise(resolve => setTimeout(resolve, 500));
    }
    stage = 'transfer';
    const selections = [database, application].map(({ componentId, release }) => ({ componentId, release }));
    assert.equal((await activateOrTransferPostgresComponent(id, selections, generation)).action, 'transferred');
    stage = 'replay';
    assert.equal((await activateOrTransferPostgresComponent(id, selections)).action, 'noop');
    const rows = await withLocalPostgresBootstrap('/run/treeseed/postgres/socket', next.postgres!.allocations[0]!.database,
      session => session.query('SELECT id FROM public.lifecycle_acceptance ORDER BY id'));
    assert.deepEqual(rows.rows.map(row => row.id), [1, 2, 3]);
    assert.equal((await postgresDocker(['inspect', '--format', '{{.State.Running}}', source], 10, true)).trim(), 'false');
    assert.equal(createHash('sha256').update(readFileSync(join(data, 'global/pg_control'))).digest('hex'), originalControl);
    assert.equal(existsSync('/var/lib/treeseed/postgres-transfer-hold.json'), false);
    // The manager normally records the newly accepted component inventory.
    writeFileSync('/var/lib/treeseed/manager/active-components.json', JSON.stringify([database, application]), { mode: 0o600 });
  } catch (error) {
    // Fixed failure stages only; never expose driver errors or credential data.
    const phase = error instanceof Error ? /PostgreSQL transfer failed \(([a-z-]+)\)/u.exec(error.message)?.[1] : undefined;
    console.error(JSON.stringify({ fixture: 'managed-transfer', stage, phase,
      frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => /^\s+at /u.test(line)).slice(0, 8) : [],
    }));
    throw new Error('Disposable managed transfer acceptance failed');
  } finally {
    if (created) await postgresDocker(['rm', '--force', source], 30);
    for (const path of temporaryPaths) rmSync(path, { recursive: path === '/var/lib/treeseed/postgres-transfers', force: true });
    for (const suffix of ['', '.sha256']) rmSync(`/var/lib/treeseed/backups/generation-${generation}.tar.gz.enc${suffix}`, { force: true });
    rmSync(data, { recursive: true, force: true });
  }
}
