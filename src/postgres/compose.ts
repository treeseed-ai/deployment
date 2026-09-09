/** One server per selected installation/environment; applications own databases. */
export const POSTGRES_IMAGE = 'postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
export { prepareManagedPostgresBootstrap } from './bootstrap.js';

export function managedPostgresService(options: { configurationRoot: string; stateRoot: string }) {
  for (const path of [options.configurationRoot, options.stateRoot]) {
    if (!path.startsWith('/') || path === '/' || path.split('/').some(part => part === '..' || part === '.') || /[\r\n\0$]/u.test(path)) {
      throw new Error('PostgreSQL custody roots must be explicit absolute directories');
    }
  }
  const bind = (source: string, target: string, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly });
  return {
    image: POSTGRES_IMAGE, restart: 'unless-stopped', networks: ['private'],
    entrypoint: ['/bin/sh', '-ec', 'mkdir -p /run/treeseed-postgres /run/postgres/socket; chown postgres:postgres /run/postgres/socket; chmod 700 /run/postgres/socket; cp /run/postgres/tls/key.pem /run/treeseed-postgres/key.pem; chown postgres:postgres /run/treeseed-postgres/key.pem; chmod 600 /run/treeseed-postgres/key.pem; exec docker-entrypoint.sh "$@"', '--'],
    command: ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/postgres/tls/cert.pem', '-c', 'ssl_key_file=/run/treeseed-postgres/key.pem', '-c', 'unix_socket_directories=/var/run/postgresql,/run/postgres/socket'],
    environment: { POSTGRES_DB: 'postgres', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD_FILE: '/run/postgres/bootstrap-password' },
    volumes: [bind(`${options.stateRoot}/postgres`, '/var/lib/postgresql/data', false),
      bind(`${options.configurationRoot}/bootstrap-password`, '/run/postgres/bootstrap-password'),
      bind(`${options.configurationRoot}/socket`, '/run/postgres/socket', false),
      bind(`${options.configurationRoot}/tls`, '/run/postgres/tls')],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres -d postgres'], interval: '5s', timeout: '5s', retries: 30 },
    security_opt: ['no-new-privileges:true'],
  };
}
