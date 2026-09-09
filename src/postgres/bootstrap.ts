import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { OsSecretCustody, type CredentialCommand } from '../security/custody/os.js';
import { LocalSecretCustody } from '../security/custody/local.js';

/** Privileged Deployment bootstrap only. Independent of API/vault availability. */
export function prepareManagedPostgresBootstrap(options: {
  stateRoot: string; runtimeRoot: string; hostname: string; environment: 'staging' | 'production';
  credentialCommand?: CredentialCommand;
}) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(options.hostname) || !['staging', 'production'].includes(options.environment)) {
    throw new Error('Invalid managed PostgreSQL bootstrap identity');
  }
  for (const root of [options.stateRoot, options.runtimeRoot]) {
    if (!isAbsolute(root) || resolve(root) !== root || root === '/') throw new Error('Invalid PostgreSQL custody root');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    new LocalSecretCustody(root); // Reject aliases, writable ancestors and foreign ownership.
  }
  const data = join(options.stateRoot, 'postgres');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (lstatSync(data).isSymbolicLink()) throw new Error('Unsafe PostgreSQL data directory');
  const store = new OsSecretCustody(join(options.stateRoot, 'postgres-os'), false, options.credentialCommand);
  const scope = { team: 'host', project: 'postgres', environment: options.environment, purpose: 'bootstrap', name: 'server' };
  let identity = store.initialized ? store.run(custody => custody.read(scope))?.values : undefined;
  if (!identity) {
    if (store.initialized) throw new Error('Existing PostgreSQL bootstrap custody does not match this environment');
    if (readdirSync(data).length) throw new Error('Existing PostgreSQL data requires original bootstrap custody; restore it before proceeding');
    const temporary = mkdtempSync(join(options.runtimeRoot, 'tls-'));
    try {
      execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365',
        '-subj', '/CN=treeseed-postgres', '-addext', `subjectAltName=DNS:${options.hostname}`,
        '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      identity = { hostname: options.hostname, password: randomBytes(32).toString('base64url'),
        privateKey: readFileSync(join(temporary, 'key.pem'), 'utf8'), certificate: readFileSync(join(temporary, 'cert.pem'), 'utf8') };
      store.run(custody => custody.write(scope, identity!, 0), true);
    } catch { throw new Error('Managed PostgreSQL bootstrap custody initialization failed'); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (identity.hostname !== options.hostname || !identity.password || !identity.privateKey || !identity.certificate) {
    throw new Error('Managed PostgreSQL bootstrap binding changed or is incomplete; explicit recovery is required');
  }
  const tls = join(options.runtimeRoot, 'tls');
  const socket = join(options.runtimeRoot, 'socket');
  mkdirSync(socket, { mode: 0o700, recursive: true });
  if (!lstatSync(socket).isDirectory() || lstatSync(socket).isSymbolicLink() || (lstatSync(socket).mode & 0o077)) throw new Error('Unsafe PostgreSQL socket directory');
  mkdirSync(tls, { mode: 0o755, recursive: true });
  const stat = lstatSync(tls);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Unsafe PostgreSQL TLS directory');
  const materialize = (path: string, value: string, mode: number) => {
    const temporary = `${path}.${randomUUID()}`;
    writeFileSync(temporary, value, { mode, flag: 'wx' });
    renameSync(temporary, path);
  };
  materialize(join(options.runtimeRoot, 'bootstrap-password'), identity.password, 0o600);
  materialize(join(tls, 'key.pem'), identity.privateKey, 0o600);
  materialize(join(tls, 'cert.pem'), identity.certificate, 0o644);
  return { configured: true, custody: 'os' as const, environment: options.environment, hostname: options.hostname };
}
