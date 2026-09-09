/** One server per selected installation/environment; applications own databases. */
export const POSTGRES_IMAGE = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';

export function managedPostgresService(options: { configurationRoot: string; stateRoot: string }) {
  for (const path of [options.configurationRoot, options.stateRoot]) {
    if (!path.startsWith('/') || path === '/' || path.split('/').some(part => part === '..' || part === '.') || /[\r\n\0$]/u.test(path)) {
      throw new Error('PostgreSQL custody roots must be explicit absolute directories');
    }
  }
  const bind = (source: string, target: string, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly });
  return {
    image: POSTGRES_IMAGE, restart: 'unless-stopped', networks: ['private'],
    entrypoint: ['/bin/sh', '-ec', 'mkdir -p /run/treeseed-postgres; cp /run/postgres/tls/key.pem /run/treeseed-postgres/key.pem; chown postgres:postgres /run/treeseed-postgres/key.pem; chmod 600 /run/treeseed-postgres/key.pem; exec docker-entrypoint.sh "$@"', '--'],
    command: ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/postgres/tls/cert.pem', '-c', 'ssl_key_file=/run/treeseed-postgres/key.pem'],
    environment: { POSTGRES_DB: 'postgres', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD_FILE: '/run/postgres/bootstrap-password' },
    volumes: [bind(`${options.stateRoot}/postgres`, '/var/lib/postgresql/data', false),
      bind(`${options.configurationRoot}/bootstrap-password`, '/run/postgres/bootstrap-password'),
      bind(`${options.configurationRoot}/tls`, '/run/postgres/tls')],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres -d postgres'], interval: '5s', timeout: '5s', retries: 30 },
    security_opt: ['no-new-privileges:true'],
  };
}
