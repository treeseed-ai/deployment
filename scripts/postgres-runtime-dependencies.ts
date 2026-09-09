/** Exact dependency closure is verified against the lock-installed packages.
 * Kept separate from SDK/CLI ownership: only the manager needs PostgreSQL.
 */
export const postgresRuntimePaths = [
  'pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass', 'pg-cloudflare',
  'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'split2', 'xtend',
] as const;
