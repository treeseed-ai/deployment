import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareManagedPostgresBootstrap } from '../src/postgres/bootstrap.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function options() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-postgres-bootstrap-')); roots.push(root);
  return { stateRoot: join(root, 'state'), runtimeRoot: join(root, 'runtime'), hostname: 'postgres', environment: 'staging' as const,
    credentialCommand: (args: string[]) => args[0] === 'encrypt' ? Buffer.from('synthetic-sealed-key') : Buffer.alloc(32, 7) };
}
it('preserves bootstrap identity across repeated preparation with encrypted persistent custody', () => {
  const input = options();
  expect(prepareManagedPostgresBootstrap(input).configured).toBe(true);
  const password = readFileSync(join(input.runtimeRoot, 'bootstrap-password'));
  const certificate = readFileSync(join(input.runtimeRoot, 'tls/cert.pem'));
  prepareManagedPostgresBootstrap(input);
  expect(readFileSync(join(input.runtimeRoot, 'bootstrap-password')).equals(password)).toBe(true);
  expect(readFileSync(join(input.runtimeRoot, 'tls/cert.pem')).equals(certificate)).toBe(true);
  expect(statSync(join(input.runtimeRoot, 'bootstrap-password')).mode & 0o777).toBe(0o600);
  for (const file of readdirSync(join(input.stateRoot, 'postgres-os'))) {
    expect(readFileSync(join(input.stateRoot, 'postgres-os', file)).includes(password)).toBe(false);
  }
  expect(() => prepareManagedPostgresBootstrap({ ...input, hostname: 'other' })).toThrow('binding changed');
  expect(() => prepareManagedPostgresBootstrap({ ...input, environment: 'production' })).toThrow('does not match this environment');
});
it('does not initialize over existing data without custody', () => {
  const input = options();
  mkdirSync(join(input.stateRoot, 'postgres'), { recursive: true, mode: 0o700 });
  writeFileSync(join(input.stateRoot, 'postgres/PG_VERSION'), '16');
  expect(() => prepareManagedPostgresBootstrap(input)).toThrow('original bootstrap custody');
});
it.each([0o007, 0o077])('materializes exact public and private modes under supervisor umask %i', mask => {
  const input = options(), previous = process.umask(mask);
  try {
    prepareManagedPostgresBootstrap(input);
    const mode = (path: string) => statSync(join(input.runtimeRoot, path)).mode & 0o777;
    expect(mode('tls')).toBe(0o755);
    expect(mode('tls/cert.pem')).toBe(0o644);
    expect(mode('hba.conf')).toBe(0o444);
    expect(mode('tls/key.pem')).toBe(0o600);
    expect(mode('bootstrap-password')).toBe(0o600);
    expect(mode('socket')).toBe(0o700);
    prepareManagedPostgresBootstrap(input);
    expect(mode('tls/cert.pem')).toBe(0o644);
  } finally { process.umask(previous); }
});
