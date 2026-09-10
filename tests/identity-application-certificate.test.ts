import { afterAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureApplicationCertificate } from '../src/identity/application-certificate.js';
const mocks = vi.hoisted(() => ({ records: new Map<string, { values: Record<string, string> }>() }));
vi.mock('../src/security/custody/os.js', () => ({ OsSecretCustody: class {
  initialized = true;
  run<T>(callback: (store: { read(scope: unknown): { values: Record<string, string> } | null;
    write(scope: unknown, values: Record<string, string>): void }) => T) {
    return callback({ read: scope => mocks.records.get(JSON.stringify(scope)) ?? null,
      write: (scope, values) => { mocks.records.set(JSON.stringify(scope), { values }); } });
  }
} }));
const root = mkdtempSync(join(tmpdir(), 'treeseed-certificate-test-'));
afterAll(() => rmSync(root, { recursive: true }));
it('creates a real certificate, reuses it and removes every plaintext temporary key', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const input = { stateRoot: root, runtimeRoot: root, environment: 'staging' as const, clientId: 'admin',
    privateKey: key.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const certificate = ensureApplicationCertificate(input);
  expect(new X509Certificate(Buffer.from(certificate, 'base64')).checkPrivateKey(key)).toBe(true);
  expect(ensureApplicationCertificate(input)).toBe(certificate);
  expect(readdirSync(root)).toEqual([]);
  expect(JSON.stringify([...mocks.records.values()])).not.toContain('PRIVATE KEY');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => ensureApplicationCertificate({ ...input, privateKey: other })).toThrow('rotation plan');
});
