import { createPrivateKey } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareApiIdentityBootstrap } from '../src/identity/api-bootstrap.js';
import { apiIdentityFixture } from './identity-api-fixture.js';

function setup() {
  const fixture = apiIdentityFixture(), saved = new Map<string, string>();
  const ensure = vi.fn((_host: unknown, id: string, create: () => string) => {
    if (!saved.has(id)) saved.set(id, create());
    return saved.get(id)!;
  });
  const materialize = vi.fn(() => ({ action: 'materialized' as const,
    directory: '/run/treeseed/identity-clients/api', mount: '/run/treeseed/identity/api' }));
  return { ...fixture, saved, dependencies: { ensure, materialize } };
}

it('initializes independent sealed keys once, then materializes through the fixed mount', () => {
  const { configuration, release, saved, dependencies } = setup();
  const result = prepareApiIdentityBootstrap(configuration, release, dependencies);
  expect(result).toEqual({ configured: true, applications: 1 });
  expect(Buffer.from(saved.get('acceptance-api-session')!, 'base64url')).toHaveLength(32);
  expect(createPrivateKey(saved.get('acceptance-admin-signing')!).asymmetricKeyDetails?.modulusLength).toBe(3072);
  const first = [...saved];
  expect(prepareApiIdentityBootstrap(configuration, release, dependencies)).toEqual(result);
  expect([...saved]).toEqual(first);
  expect(dependencies.materialize).toHaveBeenCalledTimes(2);
  for (const secret of saved.values()) expect(JSON.stringify(result)).not.toContain(secret);
});

it('does not activate Identity implicitly on an older component configuration', () => {
  const { configuration, release, dependencies } = setup();
  delete configuration.components.api!.configuration.identityRuntime;
  expect(prepareApiIdentityBootstrap(configuration, release, dependencies)).toEqual({ configured: false });
  expect(dependencies.ensure).not.toHaveBeenCalled();
  expect(dependencies.materialize).not.toHaveBeenCalled();
});

it('validates all references before generating any key', () => {
  const { configuration, release, dependencies } = setup();
  delete configuration.secrets['acceptance-admin-signing'];
  expect(() => prepareApiIdentityBootstrap(configuration, release, dependencies)).toThrow();
  expect(dependencies.ensure).not.toHaveBeenCalled();
});

it('never fabricates a missing historical key or starts the writer after materialization fails', () => {
  const { configuration, release, descriptor, dependencies } = setup();
  configuration.secrets['old-session'] = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/old-session.cred' };
  configuration.components.api!.configuration.identityRuntime = { ...descriptor,
    sessionKeys: { ...descriptor.sessionKeys, active: { ...descriptor.sessionKeys.active, version: 2 },
      historical: [{ version: 1, credentialReference: 'old-session' }] } };
  expect(() => prepareApiIdentityBootstrap(configuration, release, dependencies)).toThrow('Historical Identity session key requires recovery');
  expect(dependencies.materialize).not.toHaveBeenCalled();
  configuration.components.api!.configuration.identityRuntime = descriptor;
  dependencies.materialize.mockImplementation(() => { throw new Error('writer must remain stopped'); });
  expect(() => prepareApiIdentityBootstrap(configuration, release, dependencies)).toThrow('writer must remain stopped');
});
