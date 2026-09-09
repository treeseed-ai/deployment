import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createLocalJWKSet } from 'jose';
import { createDeviceAuthorizationClient } from '@treeseed/identity';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const deviceClient = { clientId: 'cli', enabled: true, protocol: 'openid-connect', publicClient: true,
  consentRequired: true,
  standardFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
  attributes: { 'oauth2.device.authorization.grant.enabled': 'true' },
  protocolMappers: [{ name: 'api-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
    config: { 'included.custom.audience': 'https://api.example.test', 'access.token.claim': 'true' } }] };

export async function verifyDevice(root: string, issuer: string, password: string) {
  const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  const keys = createLocalJWKSet(await (await fetch(discovery.jwks_uri)).json());
  const resource = 'https://api.example.test';
  const client = await createDeviceAuthorizationClient({ issuer, clientId: 'cli', resources: [resource], profile: 'keycloak', transport: fetch,
    verificationKey: keys, resolvePrincipal: async identity => ({ principalId: identity.subject, kind: 'human' }) });
  const pending = await client.begin({ resource, scopes: [] });
  assert.equal((await pending.poll()).status, 'pending');
  const certificate = new X509Certificate(readFileSync(join(root, 'tls/cert.pem')));
  const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
  let stage = 'verification-code';
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(pending.verificationUri);
    await page.locator('input[name="device_user_code"]').fill(pending.userCode);
    await page.locator('#kc-user-verify-device-user-code-form input[type="submit"]').click();
    stage = 'human-login';
    await page.locator('input[name="username"]').fill('acceptance-user');
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="login"],button[name="login"]').click();
    stage = 'consent';
    await page.locator('input[name="accept"]').click();
    stage = 'token';
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await pending.poll();
      if (result.status === 'authorized') {
        assert.equal(result.resource, resource); assert.equal(result.principal.kind, 'human');
        await assert.rejects(pending.poll());
        return ['real-device-human-authorization', 'device-api-audience', 'device-single-use'];
      }
      assert.equal(result.status, 'pending');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Device authorization did not complete');
  } catch { throw new Error(`Device acceptance failed (${stage})`); }
  finally { pending.cancel(); await browser.close(); }
}
