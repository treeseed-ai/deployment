import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareManagedPostgresBootstrap } from '../../dist/src/postgres/bootstrap.js';
import { managedPostgresService } from '../../dist/src/postgres/compose.js';
import { withLocalPostgresBootstrap } from '../../dist/src/postgres/connection.js';

// Runs as root only on the disposable Actions runner, never on a user's host.
if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable privileged Actions acceptance required');
const root = mkdtempSync('/run/treeseed-postgres-acceptance-');
const name = `treeseed-postgres-test-${randomBytes(8).toString('hex')}`;
const options = { stateRoot: join(root, 'state'), runtimeRoot: join(root, 'runtime'), hostname: 'postgres', environment: 'staging' as const };
const compose = join(root, 'compose.json');
const docker = (...args: string[]) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
let started = false;
try {
  prepareManagedPostgresBootstrap(options); // Real systemd-creds, not the unit-test stub.
  const service = managedPostgresService({ configurationRoot: options.runtimeRoot, stateRoot: options.stateRoot });
  const runtime = { ...service, container_name: name, volumes: service.volumes.filter(volume => volume.target !== '/var/lib/postgresql/data'), tmpfs: ['/var/lib/postgresql/data'] };
  writeFileSync(compose, JSON.stringify({ services: { postgres: runtime }, networks: { private: { internal: true } } }));
  started = true; docker('compose', '-p', name, '-f', compose, 'up', '-d', '--wait');
  assert.ok(Object.values(JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name))).every(value => value === null));
  const directory = join(options.runtimeRoot, 'socket');
  const who = await withLocalPostgresBootstrap(directory, 'postgres', session => session.query('SELECT current_user AS username'));
  assert.equal(who.rows[0]?.username, 'postgres');
  prepareManagedPostgresBootstrap(options); // Preserve custody with the running socket owned by PostgreSQL.
  chmodSync(directory, 0o755);
  await assert.rejects(withLocalPostgresBootstrap(directory, 'postgres', async () => true), /Unsafe PostgreSQL bootstrap socket/);
  chmodSync(directory, 0o700);
  console.log(JSON.stringify({ ok: true, checks: ['real-os-bootstrap-custody', 'root-unix-bootstrap', 'no-host-tcp-port', 'socket-permission-denial', 'running-bootstrap-replay'] }));
} catch {
  throw new Error('Disposable local PostgreSQL bootstrap acceptance failed');
} finally {
  if (started) docker('compose', '-p', name, '-f', compose, 'down', '--volumes');
  rmSync(root, { recursive: true, force: true });
}
