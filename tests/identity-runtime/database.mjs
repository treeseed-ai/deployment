import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedPostgresService } from '../../src/postgres/compose.ts';

/** Disposable allocation harness. Production reconciliation is a separate gate. */
export function startSharedDatabase({ root, prefix, password, docker }) {
  const name = `${prefix}-postgres`;
  writeFileSync(join(root, 'bootstrap-password'), password, { mode: 0o444 });
  const service = managedPostgresService({ configurationRoot: root, stateRoot: join(root, 'state') });
  service.volumes = service.volumes.filter(volume => volume.target !== '/var/lib/postgresql/data');
  const path = join(root, 'postgres-compose.json');
  writeFileSync(path, JSON.stringify({ services: { postgres: { ...service, container_name: name, tmpfs: ['/var/lib/postgresql/data'] } },
    networks: { private: { external: true, name: prefix } } }));
  docker('compose', '-p', `${prefix}-database`, '-f', path, 'up', '-d', '--wait');
  const sql = (query, database = 'postgres') => execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
  });
  return {
    name,
    allocate(label, secret) {
      assert.ok(['sovereign', 'central'].includes(label)); assert.match(secret, /^[a-f0-9]{64}$/);
      const database = `identity_${label}`;
      sql(`CREATE ROLE ${database} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE DATABASE ${database} OWNER ${database}; REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${database};`);
      return { hostname: 'postgres', port: 5432, database, username: database };
    },
    verifyIsolation(secret) {
      const client = query => execFileSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${secret}`, name, 'psql', '-h', '127.0.0.1', '-U', 'identity_sovereign', '-d', 'identity_sovereign', '-At', '-v', 'ON_ERROR_STOP=1'], {
        input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      assert.equal(client("SELECT has_database_privilege(current_user, 'identity_central', 'CONNECT');").trim(), 'f');
      assert.throws(() => client('\\connect identity_central\nSELECT 1;'));
      assert.equal(sql("SELECT count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename IN ('identity_sovereign','identity_central') AND NOT s.ssl;").trim(), '0');
      assert.throws(() => client('CREATE ROLE forbidden;'));
      assert.throws(() => client('CREATE DATABASE forbidden;'));
      assert.throws(() => client('SET ROLE postgres;'));
      return ['shared-postgres-server', 'cross-database-connect-denied', 'application-role-escalation-denied', 'keycloak-database-tls'];
    },
  };
}
