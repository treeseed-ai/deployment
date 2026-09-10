import { expect, it } from 'vitest';
import { postgresStartupDiagnostic } from '../src/postgres/startup-diagnostic.js';

it.each([
  ['FATAL: could not load private key file "/secret/key": Permission denied', 'tls-key-unavailable'],
  ['initdb: error: directory "/secret/data" exists but is not empty', 'data-directory-not-empty'],
  ['FATAL: database files are incompatible with server', 'data-version-incompatible'],
  ['could not access the server configuration file "/secret/config"', 'configuration-unavailable'],
  ['initdb: error: invalid locale name', 'locale-unavailable'],
  ['mkdir: cannot create directory: Read-only file system', 'read-only-filesystem'],
])('classifies %s without returning source text', (input, code) => {
  const result = postgresStartupDiagnostic(`${input}\npassword=private\nSELECT sensitive FROM private_table`);
  expect(result?.reasons).toContain(code);
  expect(JSON.stringify(result)).not.toMatch(/secret|sensitive|private_table|password=/u);
});
it('ignores unstructured secrets and bounds retained input', () => {
  expect(postgresStartupDiagnostic('credential-value-only')).toBeNull();
  expect(postgresStartupDiagnostic(null)).toBeNull();
  expect(postgresStartupDiagnostic(`Permission denied${' '.repeat(65536)}`)).toBeNull();
});
