import { expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { apiIdentityMaterial } from '../src/identity/api-material.js';
import { apiIdentityFixture } from './identity-api-fixture.js';

it('binds the full descriptor and independent references to the published API owner', () => {
  const { configuration, release, descriptor } = apiIdentityFixture();
  const buffers = [Buffer.alloc(43, 'a'), Buffer.alloc(100, 'b')];
  const read = vi.fn().mockReturnValueOnce(buffers[0]).mockReturnValueOnce(buffers[1]);
  const material = apiIdentityMaterial(configuration, release, read);
  expect(JSON.parse(material.files.get('runtime.json')!.toString())).toEqual(descriptor);
  expect([...material.files.keys()]).toEqual(['runtime.json', 'credentials/acceptance-api-session', 'credentials/acceptance-admin-signing']);
  expect(material.owner).toEqual({ uid: 65532, gid: 65532 });
  material.clear();
  for (const value of material.files.values()) expect(value.every(byte => byte === 0)).toBe(true);
});

it.each(['file', 'missing', 'path', 'disabled', 'digest', 'owner', 'descriptor'] as const)('denies %s before reading credentials', defect => {
  const { configuration, release, descriptor } = apiIdentityFixture();
  if (defect === 'file') configuration.secrets['acceptance-api-session'] = { provider: 'file', reference: '/etc/treeseed/credentials/acceptance-api-session' };
  if (defect === 'missing') delete configuration.secrets['acceptance-api-session'];
  if (defect === 'path') configuration.secrets['acceptance-api-session']!.reference = '/unmanaged/credential';
  if (defect === 'disabled') configuration.components.api!.enabled = false;
  if (defect === 'digest') release.runtimeDigest = `sha256:${'f'.repeat(64)}`;
  if (defect === 'owner') { release.runtime.postgresLifecycle = []; release.runtimeDigest = deploymentDigest(release.runtime); }
  if (defect === 'descriptor') descriptor.applications[0]!.signingKeyReference = '../escape';
  const read = vi.fn();
  expect(() => apiIdentityMaterial(configuration, release, read)).toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('preserves the exact published container identity, including the existing root API image', () => {
  const { configuration, release } = apiIdentityFixture();
  release.runtime.postgresLifecycle![0]!.credentialOwner = { uid: 0, gid: 0 };
  release.runtimeDigest = deploymentDigest(release.runtime);
  const material = apiIdentityMaterial(configuration, release, () => Buffer.alloc(43, 'a'));
  expect(material.owner).toEqual({ uid: 0, gid: 0 });
  material.clear();
});

it.each(['unavailable', 'invalid'] as const)('clears every resolved buffer on %s and redacts provider failures', defect => {
  const { configuration, release } = apiIdentityFixture();
  const first = Buffer.alloc(43, 'a'), second = Buffer.from('private-failure');
  let count = 0;
  const read = () => { if (!count++) return first; if (defect === 'invalid') return second; throw new Error('private-failure'); };
  expect(() => apiIdentityMaterial(configuration, release, read)).toThrow('API Identity bootstrap material unavailable');
  expect(first.every(byte => byte === 0)).toBe(true);
  if (defect === 'invalid') expect(second.every(byte => byte === 0)).toBe(true);
});
