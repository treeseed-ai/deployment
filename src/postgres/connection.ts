import pg from 'pg';
import { postgresServerSchema } from '@treeseed/sdk/deployment';
import type { PostgresInspectionSession } from './inventory.js';

/** One bounded connection; credentials and CA must come from the selected custody binding. */
export async function withManagedPostgresSession<T>(options: {
  server: unknown; database: string; username: string; password: string; certificateAuthority: string;
}, run: (session: PostgresInspectionSession) => Promise<T>): Promise<T> {
  const server = postgresServerSchema.parse(options.server);
  if (process.env.PGREPLICATION || ![options.database, options.username].every(value => /^[a-z][a-z0-9_]{0,62}$/u.test(value)) || !options.password || !options.certificateAuthority.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Explicit PostgreSQL credentials and verified TLS trust are required');
  }
  // Never use a connection string: its SSL query options can override explicit trust.
  const client = new pg.Client({ host: server.hostname, port: server.port, database: options.database,
    user: options.username, password: options.password,
    ssl: { ca: options.certificateAuthority, rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000,
    lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000,
    application_name: 'treeseed-postgres-reconciliation', options: '-c search_path=public', client_encoding: 'UTF8',
    sslnegotiation: 'postgres', enableChannelBinding: true });
  let failed = false;
  client.on('error', () => { failed = true; });
  try {
    await client.connect();
    const result = await run({ query: async (sql, values) => {
      if (failed) throw new Error('PostgreSQL session unavailable');
      return client.query(sql, values);
    } });
    if (failed) throw new Error('PostgreSQL session unavailable');
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/u.test(error.code) ? error.code : 'unavailable';
    // Do not attach the original driver error, SQL, parameters or connection options.
    throw new Error(`Managed PostgreSQL operation failed (${code})`);
  } finally { await client.end().catch(() => undefined); }
}
