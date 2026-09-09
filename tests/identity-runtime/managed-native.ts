import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { createManagedIdentityApplications } from '../../dist/src/identity/managed-applications.js';
import { nativeFixture } from './native.js';
import { verifyDevice } from './device.js';

export async function verifyManagedNative(root: string, issuer: string, password: string, subject: string,
  registry: ReturnType<typeof createManagedIdentityApplications>) {
  const resource = 'https://api.example.test';
  for (const clientId of ['trsd', 'cli']) {
    const input = { clientId, kind: 'native' as const, resource, scopes: [], deviceAuthorization: true,
      redirectUris: clientId === 'trsd' ? ['http://127.0.0.1/callback'] : [] };
    const created = await registry.ensure(input); assert.equal(created.action, 'create'); assert.equal(created.subject, null);
    assert.equal((await registry.ensure(input)).action, 'noop');
    await assert.rejects(registry.ensure({ ...input, resource: 'https://foreign.example.test' }));
  }
  const native = await nativeFixture(resource);
  const certificate = new X509Certificate(readFileSync(join(root, 'tls/cert.pem')));
  const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
  try {
    const context = await browser.newContext();
    const checks = await native.verify(issuer, context, subject, { username: 'acceptance-user', password });
    await verifyDevice(root, issuer, password);
    return [...checks.map(value => `managed-${value}`), 'managed-native-client-noop', 'managed-native-resource-drift-denied', 'managed-device-authorization'];
  } finally { await browser.close(); await native.close(); }
}
