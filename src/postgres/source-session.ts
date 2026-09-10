import pg from 'pg';
import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import type { PostgresInspectionSession } from './inventory.js';
import type { SourceDocker } from './source-inventory.js';

const identitySchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u),
  pid: z.number().int().positive(), started: z.string().min(1), running: z.literal(true),
}).strict();

/** Internal privileged adapter for an already attested installed database.
 * No published port, extracted password, caller SQL or filesystem path. The
 * fixed fingerprint callback receives a bounded read-only PostgreSQL session.
 */
export async function withAttestedPostgresSource<T>(selection: {
  container: string; database: string; username: string; clusterIdentity: string;
  major: 16 | 17;
}, docker: SourceDocker, run: (session: PostgresInspectionSession) => Promise<T>): Promise<T> {
  let client: pg.Client | undefined;
  let failed = false;
  try {
    if (process.getuid?.() !== 0 || process.env.PGREPLICATION ||
      !/^[a-f0-9]{64}$/u.test(selection.container) ||
      !/^sha256:[a-f0-9]{64}$/u.test(selection.clusterIdentity) ||
      ![selection.database, selection.username].every(value => /^[a-z][a-z0-9_]{0,62}$/u.test(value)) ||
      ![16,17].includes(selection.major)) throw new Error();
    const inspect = async () => {
      const state = identitySchema.parse(JSON.parse(await docker(['inspect', '--format',
        '{"id":{{json .Id}},"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
        selection.container], 10, true)));
      if (state.id !== selection.container) throw new Error();
      return state;
    };
    const before = await inspect();
    client = new pg.Client({ host: `/proc/${before.pid}/root/var/run/postgresql`, port: 5432,
      user: selection.username, database: selection.database,
      password: 'attested-local-source-does-not-use-passwords', ssl: false,
      application_name: 'treeseed-postgres-source-inspection', client_encoding: 'UTF8',
      options: '-c search_path=pg_catalog -c default_transaction_read_only=on',
      connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000,
      lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 });
    client.on('error', () => { failed = true; });
    await client.connect();
    if (deploymentDigest(before) !== deploymentDigest(await inspect())) throw new Error();
    const identity = await client.query(`SELECT current_database() AS database,
      current_setting('server_version_num')::int/10000 AS major,
      (SELECT system_identifier::text FROM pg_control_system()) AS cluster`);
    const row = identity.rows[0] as Record<string, unknown> | undefined;
    if (identity.rows.length !== 1 || row?.database !== selection.database || row.major !== selection.major ||
      typeof row.cluster !== 'string' || deploymentDigest({ cluster: row.cluster }) !== selection.clusterIdentity) throw new Error();
    const connection = client;
    const result = await run({ query: async (sql, values) => {
      if (failed) throw new Error();
      return connection.query(sql, values);
    } });
    if (failed || deploymentDigest(before) !== deploymentDigest(await inspect())) throw new Error();
    return result;
  } catch {
    // Never return driver errors, SQL, process details or database values.
    throw new Error('Attested PostgreSQL source session unavailable or changed; source unchanged.');
  } finally { await client?.end().catch(() => undefined); }
}
