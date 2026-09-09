import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedPostgresService } from '../../dist/src/postgres/compose.js';
import { verifyPostgresRuntimeAccess } from '../../dist/src/postgres/verify.js';
import { verifyPostgresAllocationRuntime } from '../../dist/src/postgres/runtime-state.js';
import { withManagedPostgresSession } from '../../dist/src/postgres/connection.js';
import { inspectPostgresAllocations } from '../../dist/src/postgres/inventory.js';
import { planPostgresAllocations, applyPostgresAllocations, activatePostgresAllocation } from '../../dist/src/postgres/plan.js';
import { readFileSync } from 'node:fs';

/** Disposable allocation harness. Production reconciliation is a separate gate. */
export function startSharedDatabase({ root, prefix, password, docker }: { root: string; prefix: string; password: string; docker: (...args: string[]) => string }) {
  const name = `${prefix}-postgres`;
  writeFileSync(join(root, 'bootstrap-password'), password, { mode: 0o444 });
  const service = managedPostgresService({ configurationRoot: root, stateRoot: join(root, 'state') });
  // Privileged host socket custody is tested separately; this browser test runs unprivileged.
  service.volumes = service.volumes.filter(volume => !['/var/lib/postgresql/data', '/run/postgres/socket'].includes(volume.target));
  const path = join(root, 'postgres-compose.json');
  writeFileSync(path, JSON.stringify({ services: { postgres: { ...service, container_name: name, ports: ['127.0.0.1::5432'], tmpfs: ['/var/lib/postgresql/data'] } },
    networks: { private: { external: true, name: prefix } } }));
  docker('compose', '-p', `${prefix}-database`, '-f', path, 'up', '-d', '--wait');
  const sql = (query: string, database = 'postgres') => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '/run/postgres/socket', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
  });
  const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
  const server = { id: 'shared', installationId: 'acceptance', environment: 'staging', mode: 'shared',
    hostname: '127.0.0.1', port: Number(ports['5432/tcp'][0].HostPort), major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'test-ca' } };
  const options = { server, database: 'postgres', username: 'postgres', password, certificateAuthority: readFileSync(join(root, 'tls/cert.pem'), 'utf8') };
  const allocations = new Map<string, { topology: unknown; password: string }>();
  return {
    name,
    async verifySession() {
      const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
      const port = Number(ports['5432/tcp'][0].HostPort);
      const options = { server: { id: 'shared', installationId: 'acceptance', environment: 'staging', mode: 'shared',
        hostname: '127.0.0.1', port, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'test-ca' } },
        database: 'postgres', username: 'postgres', password, certificateAuthority: readFileSync(join(root, 'tls/cert.pem'), 'utf8') };
      const inventory = await withManagedPostgresSession(options, session => inspectPostgresAllocations('shared', session));
      assert.equal(inventory.major, 17);
      assert.ok(inventory.extensions.includes('pgcrypto'));
      await assert.rejects(withManagedPostgresSession({ ...options, password: 'incorrect' }, async () => null), /Managed PostgreSQL operation failed/);
      await assert.rejects(withManagedPostgresSession({ ...options, certificateAuthority: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----' }, async () => null), /Managed PostgreSQL operation failed/);
      return ['postgres-tls-session', 'postgres-wrong-password-denied', 'postgres-untrusted-ca-denied', 'postgres-catalog-snapshot'];
    },
    async allocate(label: string, secret: string, migrationSecret: string) {
      assert.ok(['sovereign', 'central'].includes(label)); assert.match(secret, /^[a-f0-9]{64}$/); assert.match(migrationSecret, /^[a-f0-9]{64}$/);
      const database = `identity_${label}`;
      const topology = { schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'acceptance', environment: 'staging', servers: [server],
        requirements: [{ id: label, componentId: 'identity', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 20 }],
        allocations: [{ requirementId: label, serverId: 'shared', database, ownerRole: `${database}_owner`, migrationRole: `${database}_migrator`, runtimeRole: database,
          migrationCredentialReference: `${label}-migration`, runtimeCredentialReference: `${label}-runtime`, onDisable: 'preserve' }] };
      await withManagedPostgresSession(options, async session => {
        const inventory = await inspectPostgresAllocations('shared', session);
        const plan = planPostgresAllocations(topology, [inventory]);
        const result = await applyPostgresAllocations(topology, plan, new Map([['shared', session]]));
        assert.deepEqual(result.created, [label]);
        await assert.rejects(applyPostgresAllocations(topology, plan, new Map([['shared', session]])), /allocation failed/);
        const replay = planPostgresAllocations(topology, [await inspectPostgresAllocations('shared', session)]);
        assert.deepEqual((await applyPostgresAllocations(topology, replay, new Map([['shared', session]]))).created, []);
      });
      assert.equal(sql(`SELECT count(*) FROM pg_roles WHERE rolname IN ('${database}', '${database}_owner', '${database}_migrator') AND rolcanlogin`).trim(), '0');
      await withManagedPostgresSession({ ...options, database }, session => activatePostgresAllocation(topology, label, 'migration', migrationSecret, session));
      allocations.set(label, { topology, password: secret });
      return { hostname: 'postgres', port: 5432, database, username: database };
    },
    async activateRuntime(label: string) {
      assert.ok(['sovereign', 'central'].includes(label));
      const database = `identity_${label}`;
      const allocation = { requirementId: label, serverId: 'shared', database,
        ownerRole: `${database}_owner`, migrationRole: `${database}_migrator`, runtimeRole: database,
        migrationCredentialReference: `${label}-migration`, runtimeCredentialReference: `${label}-runtime`, onDisable: 'preserve' };
      const stored = allocations.get(label); assert.ok(stored);
      await withManagedPostgresSession({ ...options, database }, session => activatePostgresAllocation(stored.topology, label, 'runtime', stored.password, session));
      const access = await verifyPostgresRuntimeAccess(allocation, { query: async query => ({ rows: [JSON.parse(sql(`SELECT row_to_json(result) FROM (${query}) result`, database))] }) });
      assert.deepEqual(access, { verified: true, blockers: [] });
    },
    async verifyIsolation(secret: string) {
      const stored = allocations.get('sovereign'); assert.ok(stored);
      const readback = () => withManagedPostgresSession({ ...options, database: 'identity_sovereign' }, session =>
        verifyPostgresAllocationRuntime(stored.topology, 'sovereign', stored.password, session));
      assert.equal((await readback()).action, 'noop');
      sql('ALTER ROLE identity_sovereign CONNECTION LIMIT 21');
      assert.ok((await readback()).blockers.includes('limits'));
      sql('ALTER ROLE identity_sovereign CONNECTION LIMIT 20');
      assert.equal((await readback()).action, 'noop');
      const wrongCredential = await withManagedPostgresSession({ ...options, database: 'identity_sovereign' }, session =>
        verifyPostgresAllocationRuntime(stored.topology, 'sovereign', 'b'.repeat(64), session));
      assert.ok(wrongCredential.blockers.includes('credentialMismatch'));
      await assert.rejects(withManagedPostgresSession({ ...options, database: 'identity_sovereign' }, session =>
        activatePostgresAllocation(stored.topology, 'sovereign', 'migration', 'b'.repeat(64), session)), /Managed PostgreSQL operation failed/);
      const client = (query: string) => execFileSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${secret}`, name, 'psql', '-h', '127.0.0.1', '-U', 'identity_sovereign', '-d', 'identity_sovereign', '-At', '-v', 'ON_ERROR_STOP=1'], {
        input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      assert.equal(client("SELECT has_database_privilege(current_user, 'identity_central', 'CONNECT');").trim(), 'f');
      assert.throws(() => client('\\connect identity_central\nSELECT 1;'));
      assert.equal(sql("SELECT count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename IN ('identity_sovereign','identity_central') AND NOT s.ssl;").trim(), '0');
      assert.throws(() => client('CREATE ROLE forbidden;'));
      assert.throws(() => client('CREATE DATABASE forbidden;'));
      assert.throws(() => client('SET ROLE postgres;'));
      assert.throws(() => client('SET ROLE identity_sovereign_owner;'));
      assert.throws(() => client('SET ROLE identity_sovereign_migrator;'));
      assert.throws(() => client('CREATE TABLE forbidden(id integer);'));
      assert.throws(() => client('ALTER TABLE user_entity ADD COLUMN forbidden integer;'));
      return ['shared-postgres-server', 'cross-database-connect-denied', 'application-role-escalation-denied', 'keycloak-database-tls', 'runtime-ddl-denied', 'runtime-migrator-escalation-denied', 'active-writer-migration-denied', 'scram-credential-activation', 'active-runtime-readback', 'connection-limit-drift', 'credential-mismatch-denied'];
    },
  };
}
