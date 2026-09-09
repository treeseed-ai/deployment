import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePostgresLogicalArchive, restorePostgresLogicalArchive } from '../../dist/src/postgres/logical-archive.js';
import { POSTGRES_IMAGE } from '../../dist/src/postgres/compose.js';
import { inspectPostgresSource } from '../../dist/src/postgres/source-inventory.js';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component } from '../fixtures.js';

// Disposable Actions only. No host ports, network, credentials or durable volumes.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Actions acceptance required');
const prefix = `treeseed-pg-transfer-test-${randomBytes(8).toString('hex')}`;
const source = `${prefix}-source`, destination = `${prefix}-destination`;
const owned = new Set([source, destination]);
const root = mkdtempSync(join(tmpdir(), 'treeseed-pg-transfer-'));
const key = randomBytes(32), intentDigest = `sha256:${createHash('sha256').update(prefix).digest('hex')}`;
const pg16 = 'postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825';
let stage = 'start';
const docker = (args: string[]) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 1_048_576 });
const sql = (name: string, database: string, query: string, user = 'postgres') => {
  assert.ok(owned.has(name));
  return docker(['exec', name, 'psql', '-X', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
};
function processStream(name: string, args: string[]) {
  assert.ok(owned.has(name));
  const child = spawn('/usr/bin/docker', ['exec', '-i', name, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Disposable database process unavailable')));
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Disposable database process failed')); });
  });
  void completed.catch(() => undefined);
  return { child, completed };
}
const checks: string[] = [];
try {
  for (const [name, image] of [[source, pg16], [destination, POSTGRES_IMAGE]] as const) {
    docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
      '--label', `com.docker.compose.project=${prefix}`, '--label', `com.docker.compose.service=${name === source ? 'source' : 'destination'}`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image, '-c', 'listen_addresses=']);
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    assert.ok(ready);
  }
  stage = 'fixture';
  assert.equal(sql(source, 'postgres', "SELECT current_setting('server_version_num')::int/10000"), '16');
  assert.equal(sql(destination, 'postgres', "SELECT current_setting('server_version_num')::int/10000"), '17');
  sql(source, 'postgres', 'CREATE DATABASE application');
  sql(source, 'application', `CREATE EXTENSION pgcrypto;
    CREATE TABLE records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL UNIQUE, payload jsonb NOT NULL);
    INSERT INTO records(label,payload) VALUES ('alpha','{"value":1}'),('雪','{"value":2}');
    CREATE TABLE links(record_id bigint REFERENCES records(id)); INSERT INTO links VALUES(1);
    CREATE VIEW labels AS SELECT id,label FROM records; GRANT SELECT ON records TO PUBLIC;`);
  sql(destination, 'postgres', `CREATE ROLE application_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE application_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE application_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT application_owner TO application_migrator;`);
  sql(destination, 'postgres', 'CREATE DATABASE application OWNER application_owner');
  sql(destination, 'postgres', 'REVOKE ALL ON DATABASE application FROM PUBLIC; GRANT CONNECT ON DATABASE application TO application_migrator,application_runtime;');
  const records = (name: string) => sql(name, 'application', 'SELECT row_to_json(r) FROM records r ORDER BY id');
  const before = records(source);
  stage = 'source-attestation';
  const release = component('api', 'development', 'a');
  release.runtime.compose.projectName = prefix;
  release.runtimeDigest = deploymentDigest(release.runtime);
  release.images = [{ role: 'postgres', repository: 'postgres', digest: pg16.split('@')[1]!, platforms: ['linux/amd64'], consumers: ['api'] }];
  const configuredSource = { services: { source: { image: pg16, environment: { POSTGRES_DB: 'application', POSTGRES_USER: 'postgres' } } } };
  const observed = await inspectPostgresSource(release, 'source', configuredSource, async args => docker(args));
  assert.equal(observed.major, 16); assert.equal(observed.database, 'application');
  assert.match(observed.clusterIdentity, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(records(source), before);
  checks.push('installed-image-source-attestation-read-only');
  stage = 'export';
  const dump = processStream(source, ['pg_dump', '-U', 'postgres', '-d', 'application', '--format=custom', '--no-tablespaces']);
  dump.child.stdin.end();
  const archive = await writePostgresLogicalArchive(root, intentDigest, key, dump.child.stdout, dump.completed);
  const target = async () => {
    const restore = processStream(destination, ['pg_restore', '-U', 'application_migrator', '-d', 'application',
      '--role=application_owner', '--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', '--single-transaction']);
    restore.child.stdout.resume();
    return { input: restore.child.stdin, completed: restore.completed };
  };
  stage = 'restore';
  await restorePostgresLogicalArchive(root, intentDigest, key, archive, target);
  assert.equal(records(destination), before); assert.equal(records(source), before);
  assert.equal(sql(destination, 'application', "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='records'::regclass"), 'application_owner');
  assert.equal(sql(destination, 'application', "SELECT has_table_privilege('application_runtime','records','SELECT')"), 'f');
  assert.equal(sql(destination, 'application', 'SELECT last_value FROM records_id_seq'), sql(source, 'application', 'SELECT last_value FROM records_id_seq'));
  assert.equal(sql(destination, 'application', 'SELECT count(*) FROM labels'), '2');
  assert.equal(sql(destination, 'application', "SELECT count(*) FROM pg_extension WHERE extname='pgcrypto'"), '1');
  assert.equal(sql(destination, 'application', "SELECT count(*) FROM pg_constraint WHERE conrelid='links'::regclass AND contype='f'"), '1');
  checks.push('pg16-to-pg17-records-sequences-view-extension-constraints', 'source-retained', 'restricted-restore-owner', 'source-public-grant-not-inherited');
  stage = 'occupied-destination';
  await assert.rejects(restorePostgresLogicalArchive(root, intentDigest, key, archive, target));
  assert.equal(records(destination), before);
  checks.push('restore-failure-transaction-keeps-existing-records');
  stage = 'tamper';
  const path = join(root, `${intentDigest.slice(7)}.pgdump.enc`), data = readFileSync(path);
  data[data.length - 1] = data[data.length - 1]! ^ 1; writeFileSync(path, data);
  const corrupt = { ...archive, digest: `sha256:${createHash('sha256').update(data).digest('hex')}` };
  let opened = false;
  await assert.rejects(restorePostgresLogicalArchive(root, intentDigest, key, corrupt, async () => { opened = true; return target(); }));
  assert.equal(opened, false); assert.equal(records(destination), before);
  checks.push('corrupt-gcm-denied-before-destination-process');
  console.log(JSON.stringify({ ok: true, checks }));
} catch { console.error(JSON.stringify({ ok: false, stage })); process.exitCode = 1; }
finally {
  key.fill(0);
  for (const name of owned) { try { docker(['rm', '-f', name]); } catch { /* Only positively owned disposable names. */ } }
  rmSync(root, { recursive: true, force: true });
}
