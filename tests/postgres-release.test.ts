import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresComponentBundle } from '../src/postgres/release.js';
import { validateProductionCompose } from '../src/runtime/compose.js';

it('publishes a portable private shared server using accepted immutable images', () => {
  const bundle = postgresComponentBundle('0.1.0-rc.277', 'a'.repeat(40));
  expect(bundle.component.runtimeDigest).toBe(deploymentDigest(bundle.component.runtime));
  expect(bundle.component.runtime.stateVolumes.every(volume => volume.backup === 'required')).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'treeseed-postgres-bundle-'));
  try {
    writeFileSync(join(root, 'compose.yml'), bundle.compose);
    expect(() => validateProductionCompose(bundle.component, root)).not.toThrow();
    expect(bundle.compose).not.toContain('"ports"');
    expect(bundle.compose).toContain('TREESEED_COMPONENT_DATA_ROOT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('requires immutable source and valid release version', () => {
  expect(() => postgresComponentBundle('latest', 'a'.repeat(40))).toThrow();
  expect(() => postgresComponentBundle('0.1.0', 'staging')).toThrow();
});
