import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareManagedPostgresBootstrap } from '../../dist/src/postgres/bootstrap.js';
import { managedPostgresService } from '../../dist/src/postgres/compose.js';
import { withLocalPostgresBootstrap } from '../../dist/src/postgres/connection.js';
import { inspectPostgresAllocations, planPostgresAllocations, applyPostgresAllocations } from '../../dist/src/postgres/plan.js';
import { ensurePostgresAllocationCredentials } from '../../dist/src/postgres/credentials.js';
import { ensureComponentCredential } from '../../dist/src/supervisor/component-sealed-write.js';
import { readComponentCredential } from '../../dist/src/supervisor/component-sealed.js';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { activatePostgresAllocation } from '../../dist/src/postgres/activation.js';
import { disablePostgresAllocation } from '../../dist/src/postgres/disable.js';
import { verifyManagedPostgres } from './managed-postgres.js';

// Runs as root only on the disposable Actions runner, never on a user's host.
if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable privileged Actions acceptance required');
const root = mkdtempSync('/run/treeseed-postgres-acceptance-');
const name = `treeseed-postgres-test-${randomBytes(8).toString('hex')}`;
assert.equal(existsSync('/run/treeseed/postgres'), false, 'Disposable runtime custody must start absent');
const options = { stateRoot: join(root, '.treeseed/data/postgres'), runtimeRoot: '/run/treeseed/postgres', hostname: 'postgres', environment: 'staging' as const };
const compose = join(root, 'compose.json');
const docker = (...args: string[]) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
let started = false;
let stage = 'os-custody';
const credentialIds = [`${name}-migration`, `${name}-runtime`];
const credentialFiles = credentialIds.map(id => `/etc/treeseed/credentials/${id}.cred`);
try {
  prepareManagedPostgresBootstrap(options); // Real systemd-creds, not the unit-test stub.
  stage = 'compose';
  const service = managedPostgresService({ configurationRoot: options.runtimeRoot, stateRoot: options.stateRoot });
  const runtime = { ...service, container_name: name, volumes: service.volumes.filter(volume => volume.target !== '/var/lib/postgresql/data'), tmpfs: ['/var/lib/postgresql/data'] };
  writeFileSync(compose, JSON.stringify({ services: { postgres: runtime }, networks: { private: { internal: true, name: 'treeseed-postgres-private' } } }));
  started = true; docker('compose', '-p', name, '-f', compose, 'up', '-d', '--wait');
  stage = 'ports';
  assert.ok(Object.values(JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name))).every(value => value === null));
  const directory = join(options.runtimeRoot, 'socket');
  stage = 'socket';
  const who = await withLocalPostgresBootstrap(directory, 'postgres', session => session.query('SELECT current_user AS username'));
  assert.equal(who.rows[0]?.username, 'postgres');
  stage = 'allocation-credentials';
  const topology = {
    schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'acceptance', environment: 'staging',
    servers: [{ id: 'shared', installationId: 'acceptance', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
    requirements: [{ id: 'acceptance', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
    allocations: [{ requirementId: 'acceptance', serverId: 'shared', database: 'acceptance', ownerRole: 'acceptance_owner', migrationRole: 'acceptance_migrator', runtimeRole: 'acceptance_runtime', migrationCredentialReference: credentialIds[0], runtimeCredentialReference: credentialIds[1], onDisable: 'preserve' }],
  };
  const host = { secrets: Object.fromEntries(credentialIds.map((id, index) => [id, { provider: 'systemd-credential', reference: credentialFiles[index] }])) } as HostConfiguration;
  await withLocalPostgresBootstrap(directory, 'postgres', async session => {
    const plan = planPostgresAllocations(topology, [await inspectPostgresAllocations('shared', session)]);
    await applyPostgresAllocations(topology, plan, new Map([['shared', session]]));
    const custody = { exists: (id: string) => existsSync(`/etc/treeseed/credentials/${id}.cred`),
      ensure: (id: string, generate: () => string) => ensureComponentCredential(host, id, generate) };
    await ensurePostgresAllocationCredentials(topology, 'acceptance', session, custody);
    const retained = credentialIds.map(id => readComponentCredential(host, id));
    await ensurePostgresAllocationCredentials(topology, 'acceptance', session, custody);
    assert.deepEqual(credentialIds.map(id => readComponentCredential(host, id)), retained);
    assert.notEqual(retained[0], retained[1]);
    stage = 'scoped-login-disable';
    await withLocalPostgresBootstrap(directory, 'acceptance', allocated => activatePostgresAllocation(topology, 'acceptance', 'runtime', retained[1]!, allocated));
    const runtime = new pg.Client({ host: directory, user: 'acceptance_runtime', database: 'acceptance', password: retained[1], ssl: false, connectionTimeoutMillis: 5000 });
    runtime.on('error', () => undefined);
    try {
      await runtime.connect(); await runtime.query('SELECT 1');
      assert.equal((await disablePostgresAllocation(topology, 'acceptance', session)).disabled, true);
      await assert.rejects(runtime.query('SELECT 1'));
      assert.equal((await session.query('SELECT current_user AS username')).rows[0]?.username, 'postgres');
    } finally { await runtime.end().catch(() => undefined); }
  });
  stage = 'managed-component-lifecycle';
  await verifyManagedPostgres(root, topology);
  stage = 'custody-replay';
  prepareManagedPostgresBootstrap(options); // Preserve custody with the running socket owned by PostgreSQL.
  stage = 'permission-denial';
  chmodSync(directory, 0o755);
  await assert.rejects(withLocalPostgresBootstrap(directory, 'postgres', async () => true), /Unsafe PostgreSQL bootstrap socket/);
  chmodSync(directory, 0o700);
  console.log(JSON.stringify({ ok: true, checks: ['real-os-bootstrap-custody', 'root-unix-bootstrap', 'no-host-tcp-port', 'socket-permission-denial', 'running-bootstrap-replay', 'allocation-os-credentials', 'credential-preserving-replay', 'scoped-runtime-login-disable', 'unrelated-bootstrap-session-preserved'] }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-zA-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'unavailable';
  console.error(JSON.stringify({ stage, code, type: error instanceof Error ? error.name : 'unknown',
    systemd: execFileSync('/usr/bin/systemd-creds', ['--version'], { encoding: 'utf8' }).split('\n')[0] }));
  throw new Error('Disposable local PostgreSQL bootstrap acceptance failed');
} finally {
  if (started) docker('compose', '-p', name, '-f', compose, 'down', '--volumes');
  for (const path of credentialFiles) rmSync(path, { force: true });
  rmSync('/run/treeseed/postgres', { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
