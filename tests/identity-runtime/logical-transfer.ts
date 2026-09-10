import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePostgresLogicalArchive, restorePostgresLogicalArchive } from '../../dist/src/postgres/logical-archive.js';
import { POSTGRES_IMAGE } from '../../dist/src/postgres/compose.js';
import { inspectPostgresSource } from '../../dist/src/postgres/source-inventory.js';
import { withAttestedPostgresSource } from '../../dist/src/postgres/source-session.js';
import { startPostgresExport, startPostgresImport } from '../../dist/src/postgres/transfer-process.js';
import { fencePostgresSourceNetworks, inspectPostgresSourceNetworks, terminatePostgresTransferWriters } from '../../dist/src/postgres/transfer-fence.js';
import { deploymentDigest, postgresTopologySchema } from '@treeseed/sdk/deployment';
import { inspectPostgresTransferDestination } from '../../dist/src/postgres/transfer-destination.js';
import { postgresAllocationId } from '../../dist/src/postgres/plan.js';
import { postgresAllocationMarker } from '../../dist/src/postgres/inventory.js';
import { activatePostgresAllocation } from '../../dist/src/postgres/activation.js';
import { backupPostgresSourceFormat } from '../../dist/src/supervisor/postgres-source-backup.js';
import { component } from '../fixtures.js';
import { fingerprintPostgresTransfer } from '../../dist/src/postgres/transfer-fingerprint.js';
import type { PostgresInspectionSession } from '../../dist/src/postgres/inventory.js';
import { postgresTransferLocaleSchema, verifyPostgresTransferFingerprints } from '../../dist/src/postgres/transfer-locale.js';

// Disposable Actions only. No host ports, external network, credentials or durable volumes.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Actions acceptance required');
const prefix = `treeseed-pg-transfer-test-${randomBytes(8).toString('hex')}`;
const source = `${prefix}-source`, destination = `${prefix}-destination`;
const probe = `${prefix}-probe`, network = `${prefix}-private`;
const owned = new Set([source, destination, probe]); let networkCreated = false;
const root = mkdtempSync(join(tmpdir(), 'treeseed-pg-transfer-'));
const key = randomBytes(32), intentDigest = `sha256:${createHash('sha256').update(prefix).digest('hex')}`;
const pg16 = 'postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825';
const alpine = 'postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const convert = process.env.TREESEED_POSTGRES_SOURCE === 'alpine';
const sourceImage = convert ? alpine : pg16, sourceMajor = convert ? 17 : 16;
let stage = 'start';
const docker = (args: string[]) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 1_048_576 });
const sql = (name: string, database: string, query: string, user = 'postgres') => {
  assert.ok(owned.has(name));
  return docker(['exec', name, 'psql', '-X', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
};
const processes: Array<{ disconnect(): void }> = [];
const checks: string[] = [];
// A persistent psql session is needed for read-only snapshots and cursors. The
// fixture uses an isolated Unix socket; managed network clients require TLS.
async function withFixtureSession<T>(name: string, inspect: (session: PostgresInspectionSession) => Promise<T>) {
  assert.ok(owned.has(name));
  const { Client } = await import('pg');
  const client = new Client({ host: join(root, name === source ? 'source' : 'destination'),
    user: 'postgres', database: 'application', connectionTimeoutMillis: 10000, query_timeout: 30000 });
  await client.connect();
  try {
    const session: PostgresInspectionSession = { query: async (query, values) => {
      const result = await client.query(query, values);
      return { rows: Array.isArray(result) ? [] : result.rows };
    } };
    return await inspect(session);
  } finally { await client.end(); }
}
const fingerprint = (name: string, owner: string, major: 16 | 17) => withFixtureSession(name,
  session => fingerprintPostgresTransfer(session, { database: 'application', owner, major }));
const topology = postgresTopologySchema.parse({
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432,
    major: 17, extensions: ['pgcrypto'], tls: { mode: 'verify-full', trustReference: 'ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: ['pgcrypto'], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'application', ownerRole: 'application_owner',
    migrationRole: 'application_migrator', runtimeRole: 'application_runtime', migrationCredentialReference: 'migration',
    runtimeCredentialReference: 'runtime', onDisable: 'preserve' }],
});
const inspectDestination = (importing = false) => withFixtureSession(destination,
  session => inspectPostgresTransferDestination(topology, 'api', session, importing));
try {
  docker(['network','create','--internal','--label','org.treeseed.test=postgres-transfer',network]); networkCreated = true;
  for (const [name, image] of [[source, sourceImage], [destination, POSTGRES_IMAGE]] as const) {
    const socket = join(root, name === source ? 'source' : 'destination');
    mkdirSync(socket); chmodSync(socket, 0o777);
    // The mode-0700 parent excludes other host users; only this owned container
    // receives its socket directory. Cross-image PostgreSQL UIDs differ.
    docker(['run', '-d', '--name', name, '--network', name === source ? network : 'none', '--tmpfs', '/var/lib/postgresql/data',
      '--label', `com.docker.compose.project=${prefix}`, '--label', `com.docker.compose.service=${name === source ? 'source' : 'destination'}`,
      '--mount', `type=bind,source=${socket},target=${name === source ? '/fixture-socket' : '/run/postgres/socket'}`,
      '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=en_US.utf8',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image, '-c', name === source ? 'listen_addresses=*' : 'listen_addresses=',
      '-c', `unix_socket_directories=/var/run/postgresql,${name === source ? '/fixture-socket' : '/run/postgres/socket'}`]);
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    assert.ok(ready);
  }
  stage = 'fixture';
  const projection = `${prefix}-projection`; owned.add(projection);
  docker(['create','--name',projection,'--network','none','--tmpfs','/var/lib/postgresql/data',
    '-e','POSTGRES_DB=application','-e','POSTGRES_USER=owner','-e','POSTGRES_PASSWORD=never-return-this',POSTGRES_IMAGE]);
  const projected = docker(['inspect','--format',backupPostgresSourceFormat,projection]);
  assert.equal(JSON.parse(projected).database,'POSTGRES_DB=application');
  assert.equal(JSON.parse(projected).username,'POSTGRES_USER=owner');
  assert.ok(!projected.includes('never-return-this')); docker(['rm',projection]);
  checks.push('backup-source-projection-excludes-passwords');
  assert.equal(sql(source, 'postgres', "SELECT current_setting('server_version_num')::int/10000"), String(sourceMajor));
  assert.equal(sql(destination, 'postgres', "SELECT current_setting('server_version_num')::int/10000"), '17');
  sql(source, 'postgres', 'CREATE DATABASE application');
  sql(source, 'application', `CREATE EXTENSION pgcrypto;
    CREATE TABLE records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL UNIQUE, payload jsonb NOT NULL);
    INSERT INTO records(label,payload) VALUES ('alpha','{"value":1}'),('雪','{"value":2}');
    CREATE TABLE links(record_id bigint REFERENCES records(id)); INSERT INTO links VALUES(1);
    CREATE VIEW labels AS SELECT id,label FROM records; GRANT SELECT ON records TO PUBLIC;`);
  sql(destination, 'postgres', `CREATE ROLE application_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE application_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE application_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT application_owner TO application_migrator;`);
  sql(destination, 'postgres', 'CREATE DATABASE application OWNER application_owner');
  stage = 'destination-custody';
  await assert.rejects(inspectDestination());
  const marker = postgresAllocationMarker(postgresAllocationId(topology, 'api'));
  assert.ok(!marker.includes("'"));
  sql(destination, 'postgres', `COMMENT ON DATABASE application IS '${marker}';
    COMMENT ON ROLE application_owner IS '${marker}';
    COMMENT ON ROLE application_migrator IS '${marker}';
    COMMENT ON ROLE application_runtime IS '${marker}';`);
  const emptyDestination = await inspectDestination();
  assert.equal(emptyDestination.empty, true);
  sql(destination, 'postgres', 'ALTER ROLE application_runtime LOGIN');
  await assert.rejects(inspectDestination());
  sql(destination, 'postgres', 'ALTER ROLE application_runtime NOLOGIN');
  assert.deepEqual(await inspectDestination(), emptyDestination);
  checks.push('unmarked-destination-denied', 'runtime-login-destination-denied', 'owned-empty-destination-attested');
  const locale = (name: string) => postgresTransferLocaleSchema.parse(JSON.parse(sql(name, 'application', `SELECT jsonb_build_object(
    'encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,'provider',d.datlocprovider,
    'version',d.datcollversion,'locale',COALESCE(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale'))
    FROM pg_database d WHERE datname=current_database()`)));
  const sourceLocale = locale(source), destinationLocale = locale(destination);
  assert.equal(destinationLocale.version, '2.36');
  if (convert) assert.equal(sourceLocale.version, null); else assert.deepEqual(sourceLocale, destinationLocale);
  const conversion = convert ? { method: 'logical-rebuild', source: sourceLocale, destination: destinationLocale } : undefined;
  const order = (name: string) => sql(name, 'application', "SELECT string_agg(value,',' ORDER BY value) FROM (VALUES ('Z'),('a'),('ä'),('b')) AS samples(value)");
  if (convert) assert.notEqual(order(source), order(destination)); else assert.equal(order(source), order(destination));
  checks.push(convert ? 'explicit-musl-to-glibc-order-change' : 'api-glibc-locale-and-order-preserved');
  sql(destination, 'postgres', 'REVOKE ALL ON DATABASE application FROM PUBLIC; GRANT CONNECT ON DATABASE application TO application_migrator,application_runtime;');
  const records = (name: string) => sql(name, 'application', 'SELECT row_to_json(r) FROM records r ORDER BY id');
  const before = records(source);
  stage = 'source-attestation';
  const release = component('api', 'development', 'a');
  release.runtime.compose.projectName = prefix;
  release.runtime.services[0]!.composeService = 'source';
  release.runtimeDigest = deploymentDigest(release.runtime);
  release.images = [{ role: 'postgres', repository: 'postgres', digest: sourceImage.split('@')[1]!, platforms: ['linux/amd64'], consumers: ['api'] }];
  const configuredSource = { services: { source: { image: sourceImage, environment: { POSTGRES_DB: 'application', POSTGRES_USER: 'postgres' } } } };
  const observed = await inspectPostgresSource(release, 'source', configuredSource, async args => docker(args));
  assert.equal(observed.major, sourceMajor); assert.equal(observed.database, 'application');
  assert.match(observed.clusterIdentity, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(records(source), before);
  checks.push('installed-image-source-attestation-read-only');
  stage = 'source-fingerprint';
  const sourceFingerprint = await fingerprint(source, 'postgres', sourceMajor);
  stage = 'attested-source-session';
  const sourceSelection = { container: observed.container, database: 'application', username: 'postgres',
    major: sourceMajor as 16 | 17, clusterIdentity: observed.clusterIdentity };
  const attested = await withAttestedPostgresSource(sourceSelection, async args => docker(args),
    session => fingerprintPostgresTransfer(session, { database: 'application', owner: 'postgres', major: sourceMajor }));
  assert.deepEqual(attested, sourceFingerprint);
  let enteredWrongCluster = false;
  await assert.rejects(withAttestedPostgresSource({ ...sourceSelection, clusterIdentity: `sha256:${'0'.repeat(64)}` },
    async args => docker(args), async () => { enteredWrongCluster = true; }));
  assert.equal(enteredWrongCluster, false); assert.equal(records(source), before);
  checks.push('attested-process-socket-fingerprint-equivalent', 'wrong-cluster-denied-before-fingerprint');
  stage = 'source-network-fence';
  const tcpProbe = () => docker(['run','--rm','--name',probe,'--network',network,'--env','PGCONNECT_TIMEOUT=2',POSTGRES_IMAGE,
    'psql','-h',source,'-U','postgres','-d','application','-At','-c','SELECT 1']).trim();
  assert.equal(tcpProbe(), '1');
  const networkInventory = await inspectPostgresSourceNetworks(observed.container, async args => docker(args));
  await fencePostgresSourceNetworks(observed.container, networkInventory.digest, async args => docker(args));
  assert.throws(tcpProbe);
  await withAttestedPostgresSource(sourceSelection, async args => docker(args),
    session => terminatePostgresTransferWriters(session, 'application', ['postgres']));
  assert.equal(records(source), before);
  checks.push('source-tcp-reachability-denied', 'network-isolated-source-retains-local-export-access');
  stage = 'export';
  const dump = startPostgresExport({ container: observed.container, database: 'application', username: 'postgres', intentDigest });
  processes.push(dump);
  const archive = await writePostgresLogicalArchive(root, intentDigest, key, dump.output, dump.completed);
  const destinationContainer = docker(['inspect', '--format', '{{.Id}}', destination]).trim();
  const target = async () => {
    const restore = startPostgresImport({ container: destinationContainer, database: 'application',
      username: 'application_migrator', owner: 'application_owner', intentDigest });
    processes.push(restore);
    return { input: restore.input, completed: restore.completed };
  };
  stage = 'restore';
  // Exercise the real host activation, including pre-provisioned extensions.
  await withFixtureSession(destination, session => activatePostgresAllocation(topology, 'api', 'migration', 'a'.repeat(64), session));
  assert.equal(sql(destination, 'application', "SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname='pgcrypto'"), 'application_owner');
  await assert.rejects(inspectDestination());
  assert.deepEqual(await inspectDestination(true), emptyDestination);
  await restorePostgresLogicalArchive(root, intentDigest, key, archive, target);
  const occupiedDestination = await inspectDestination(true);
  assert.equal(occupiedDestination.empty, false);
  assert.equal(occupiedDestination.inventoryDigest, emptyDestination.inventoryDigest);
  stage = 'destination-fingerprint';
  const destinationFingerprint = await fingerprint(destination, 'application_owner', 17);
  assert.equal(verifyPostgresTransferFingerprints(sourceFingerprint, destinationFingerprint, conversion), true);
  assert.equal(verifyPostgresTransferFingerprints(sourceFingerprint, destinationFingerprint), !convert);
  checks.push('cross-major-schema-content-owner-normalized-fingerprint');
  assert.equal(records(destination), before); assert.equal(records(source), before);
  assert.equal(sql(destination, 'application', "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='records'::regclass"), 'application_owner');
  // Real allocation activation installs bounded default grants before import;
  // runtime authentication remains disabled until the lifecycle accepts it.
  assert.equal(sql(destination, 'application', "SELECT has_table_privilege('application_runtime','records','SELECT')"), 't');
  assert.equal(sql(destination, 'postgres', "SELECT rolcanlogin FROM pg_roles WHERE rolname='application_runtime'"), 'f');
  assert.equal(sql(destination, 'application', 'SELECT last_value FROM records_id_seq'), sql(source, 'application', 'SELECT last_value FROM records_id_seq'));
  assert.equal(sql(destination, 'application', 'SELECT count(*) FROM labels'), '2');
  assert.equal(sql(destination, 'application', "SELECT count(*) FROM pg_extension WHERE extname='pgcrypto'"), '1');
  assert.equal(sql(destination, 'application', "SELECT count(*) FROM pg_constraint WHERE conrelid='links'::regclass AND contype='f'"), '1');
  checks.push('records-sequences-view-extension-constraints-preserved', 'source-retained', 'restricted-restore-owner', 'source-public-grant-not-inherited');
  assert.throws(() => sql(destination, 'application', "INSERT INTO records(label,payload) VALUES('alpha','{}')"));
  assert.equal(records(destination), before);
  // A rejected insert can advance the identity sequence; restore its captured
  // value before subsequent fingerprint drift assertions.
  sql(destination, 'application', "SELECT setval('records_id_seq',2)");
  sql(destination, 'application', 'ALTER TABLE records ADD CONSTRAINT unchecked CHECK(id>0) NOT VALID');
  await assert.rejects(fingerprint(destination, 'application_owner', 17));
  sql(destination, 'application', 'ALTER TABLE records DROP CONSTRAINT unchecked');
  sql(destination, 'application', "CREATE TABLE duplicate_probe(value text); ALTER TABLE duplicate_probe OWNER TO application_owner; INSERT INTO duplicate_probe VALUES('same'),('same')");
  assert.throws(() => sql(destination, 'application', 'CREATE UNIQUE INDEX CONCURRENTLY duplicate_probe_unique ON duplicate_probe(value)'));
  assert.equal(sql(destination, 'application', "SELECT indisvalid FROM pg_index WHERE indexrelid='duplicate_probe_unique'::regclass"), 'f');
  await assert.rejects(fingerprint(destination, 'application_owner', 17));
  sql(destination, 'application', 'DROP TABLE duplicate_probe');
  checks.push('rebuilt-unique-index-enforced', 'unvalidated-constraint-denied', 'uniqueness-conflict-invalid-index-denied');
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
  stage = 'fingerprint-drift';
  sql(destination, 'application', "UPDATE records SET payload='{}' WHERE id=1");
  assert.notEqual((await fingerprint(destination, 'application_owner', 17)).contentDigest, sourceFingerprint.contentDigest);
  sql(destination, 'application', `UPDATE records SET payload='{"value":1}' WHERE id=1`);
  sql(destination, 'application', "SELECT setval('records_id_seq',90)");
  assert.notEqual((await fingerprint(destination, 'application_owner', 17)).contentDigest, sourceFingerprint.contentDigest);
  sql(destination, 'application', "SELECT setval('records_id_seq',2)");
  sql(destination, 'application', 'ALTER TABLE records ADD CONSTRAINT nonempty CHECK(length(label)>0)');
  assert.notEqual((await fingerprint(destination, 'application_owner', 17)).schemaDigest, sourceFingerprint.schemaDigest);
  sql(destination, 'application', 'ALTER TABLE records OWNER TO postgres');
  await assert.rejects(fingerprint(destination, 'application_owner', 17));
  checks.push('row-sequence-constraint-owner-drift-denied');
  console.log(JSON.stringify({ ok: true, sourceMajor, conversion: convert, checks }));
} catch (error) {
  const diagnostic = error instanceof Error && /^Attested PostgreSQL source session unavailable or changed \([a-z-]+\/[A-Z0-9a-z]+\); source unchanged\.$/u.test(error.message) ? error.message : undefined;
  console.error(JSON.stringify({ ok: false, stage, diagnostic })); process.exitCode = 1;
}
finally {
  key.fill(0);
  for (const process of processes) process.disconnect();
  for (const name of owned) { try { docker(['rm', '-f', name]); } catch { /* Only positively owned disposable names. */ } }
  if (networkCreated) { try { docker(['network','rm',network]); } catch { /* Only the owned disposable network. */ } }
  rmSync(root, { recursive: true, force: true });
}
