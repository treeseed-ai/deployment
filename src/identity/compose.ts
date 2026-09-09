/** Deployment-owned runtime; callers supply protected files, never secret values. */
export const IDENTITY_IMAGES = {
  keycloak: 'quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54',
} as const;

export function managedIdentityServices(options: {
  publicUrl: string; configurationRoot: string;
  database: { hostname: string; port: number; database: string; username: string };
  databasePhase?: 'migration' | 'runtime';
}) {
  const url = new URL(options.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Identity requires an HTTPS origin without credentials, path, query or fragment');
  }
  const database = options.database;
  if (!database || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(database.hostname) ||
      !Number.isInteger(database.port) || database.port < 1 || database.port > 65535 ||
      ![database.database, database.username].every(value => /^[a-z][a-z0-9_]{0,62}$/u.test(value)) || database.username === 'postgres') {
    throw new Error('Identity requires an explicit restricted PostgreSQL allocation');
  }
  for (const path of [options.configurationRoot]) {
    if (!path.startsWith('/') || path === '/' || path.split('/').some(part => part === '..' || part === '.') || /[\r\n\0$]/u.test(path)) {
      throw new Error('Identity custody roots must be explicit absolute directories');
    }
  }
  const bind = (source: string, target: string, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly });
  return {
    identity: {
      image: IDENTITY_IMAGES.keycloak, restart: 'unless-stopped', networks: ['private'],
      // Keycloak has no generic *_FILE environment convention. Read the protected
      // input without tracing, then replace the shell; never serialize its value.
      entrypoint: ['/bin/bash', '-ec', 'KC_DB_PASSWORD="$(cat /run/identity/database-password)"; export KC_DB_PASSWORD; exec /opt/keycloak/bin/kc.sh "$@"', '--'],
      command: ['start', '--http-enabled=false', '--https-port=8443',
        `--spi-connections-jpa--quarkus--migration-strategy=${options.databasePhase === 'migration' ? 'update' : 'validate'}`,
        `--spi-connections-jpa--quarkus--initialize-empty=${options.databasePhase === 'migration' ? 'true' : 'false'}`,
        '--https-certificate-file=/run/identity/tls/cert.pem', '--https-certificate-key-file=/run/identity/tls/key.pem',
        '--truststore-paths=/run/identity/tls/cert.pem'],
      environment: { KC_DB: 'postgres', KC_DB_URL: `jdbc:postgresql://${database.hostname}:${database.port}/${database.database}?sslmode=verify-full&sslrootcert=/run/identity/database-ca.pem`, KC_DB_USERNAME: database.username, KC_HOSTNAME: url.origin },
      volumes: [bind(options.configurationRoot, '/run/identity')],
      security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
    },
  };
}
