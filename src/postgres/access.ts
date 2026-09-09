import { postgresAllocationSchema } from '@treeseed/sdk/deployment';

/** Apply inside the selected allocation database, after migrations and before runtime starts.
 * Only the authenticated allocator may execute this policy. It contains no credentials.
 */
export function postgresRuntimeAccessSql(input: unknown): string {
  const allocation = postgresAllocationSchema.parse(input);
  const quote = (name: string) => `"${name}"`;
  const database = quote(allocation.database), owner = quote(allocation.ownerRole);
  const migration = quote(allocation.migrationRole), runtime = quote(allocation.runtimeRole);
  return `ALTER ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ${owner} FROM ${runtime};
REVOKE ${migration} FROM ${runtime};
REVOKE ALL ON DATABASE ${database} FROM PUBLIC, ${runtime};
GRANT CONNECT ON DATABASE ${database} TO ${migration}, ${runtime};
ALTER SCHEMA public OWNER TO ${owner};
REVOKE ALL ON SCHEMA public FROM PUBLIC, ${runtime};
GRANT USAGE ON SCHEMA public TO ${runtime};
GRANT USAGE, CREATE ON SCHEMA public TO ${migration};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${runtime};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${runtime};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime};
${[owner, migration].map(role => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${role} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime};`).join('\n')}`;
}
