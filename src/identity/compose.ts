/** Deployment-owned runtime; callers supply protected files, never secret values. */
export const IDENTITY_IMAGES = {
  keycloak: 'quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54',
  postgres: 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94',
} as const;

export function managedIdentityServices(options: {
  publicUrl: string; configurationRoot: string; stateRoot: string;
}) {
  const url = new URL(options.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Identity requires an HTTPS origin without credentials, path, query or fragment');
  }
  for (const path of [options.configurationRoot, options.stateRoot]) {
    if (!path.startsWith('/') || path === '/' || path.split('/').some(part => part === '..' || part === '.') || /[\r\n\0$]/u.test(path)) {
      throw new Error('Identity custody roots must be explicit absolute directories');
    }
  }
  const bind = (source: string, target: string, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly });
  return {
    'identity-database': {
      image: IDENTITY_IMAGES.postgres, restart: 'unless-stopped', networks: ['private'],
      environment: { POSTGRES_DB: 'identity', POSTGRES_USER: 'identity', POSTGRES_PASSWORD_FILE: '/run/identity/database-password' },
      volumes: [bind(`${options.stateRoot}/postgres`, '/var/lib/postgresql/data', false),
        bind(`${options.configurationRoot}/database-password`, '/run/identity/database-password')],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U identity -d identity'], interval: '5s', timeout: '5s', retries: 30 },
      security_opt: ['no-new-privileges:true'],
    },
    identity: {
      image: IDENTITY_IMAGES.keycloak, restart: 'unless-stopped', networks: ['private'],
      depends_on: { 'identity-database': { condition: 'service_healthy' } },
      // Keycloak has no generic *_FILE environment convention. Read the protected
      // input without tracing, then replace the shell; never serialize its value.
      entrypoint: ['/bin/bash', '-ec', 'KC_DB_PASSWORD="$(cat /run/identity/database-password)"; export KC_DB_PASSWORD; exec /opt/keycloak/bin/kc.sh "$@"', '--'],
      command: ['start', '--http-enabled=false', '--https-port=8443',
        '--https-certificate-file=/run/identity/tls/cert.pem', '--https-certificate-key-file=/run/identity/tls/key.pem',
        '--truststore-paths=/run/identity/tls/cert.pem'],
      environment: { KC_DB: 'postgres', KC_DB_URL: 'jdbc:postgresql://identity-database:5432/identity', KC_DB_USERNAME: 'identity', KC_HOSTNAME: url.origin },
      volumes: [bind(options.configurationRoot, '/run/identity')],
      security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
    },
  };
}
