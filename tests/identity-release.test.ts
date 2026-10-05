import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { identityComponentBundle } from '../src/identity/release.js';
import { validateProductionCompose } from '../src/runtime/compose.js';
import { edgeRoutes, renderCaddyfile } from '../src/edge/caddy.js';

it('publishes an immutable Identity runtime with isolated migration and bootstrap mounts', () => {
  const bundle = identityComponentBundle('0.1.0-rc.277', 'a'.repeat(40));
  expect(bundle.component.runtimeDigest).toBe(deploymentDigest(bundle.component.runtime));
  const compose = JSON.parse(bundle.compose);
  expect(compose.services.identity.volumes.map((v: { source: string }) => v.source)).toEqual([
    '/run/treeseed/identity/tls', '/run/treeseed/identity/themes', '/run/treeseed/postgres-clients/identity/identity/runtime']);
  expect(compose.services.identity.volumes.find((v: { target: string }) => v.target === '/opt/keycloak/themes')).toMatchObject({ read_only: true });
  expect(compose.services['identity-migration'].command).toContain('--import-realm');
  expect(compose.services.identity.command).not.toContain('--import-realm');
  expect(bundle.compose).not.toMatch(/reconcilerKey|"ports"/);
  expect(compose.services.identity.environment).not.toHaveProperty('KC_DB_PASSWORD');
  expect(compose.services['identity-migration'].environment).not.toHaveProperty('KC_DB_PASSWORD');
  const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-bundle-'));
  try {
    writeFileSync(join(root, 'compose.yml'), bundle.compose);
    expect(() => validateProductionCompose(bundle.component, root)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
  const caddy = renderCaddyfile(edgeRoutes([bundle.component]));
  expect(caddy).toContain('reverse_proxy https://identity:8443');
  expect(caddy).toContain('tls_trust_pool file /etc/treeseed/edge/tls/client-ca.crt');
  expect(caddy).not.toContain('insecure_skip_verify');
});
