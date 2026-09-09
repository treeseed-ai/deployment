import { describe, expect, it } from 'vitest';
import { managedIdentityServices, IDENTITY_IMAGES } from '../src/identity/compose.js';

const input = { publicUrl: 'https://identity.example.test', configurationRoot: '/run/treeseed/identity', stateRoot: '/var/lib/treeseed/components/identity' };
describe('managed identity services', () => {
  it('uses immutable images, independent PostgreSQL and protected file inputs', () => {
    const services = managedIdentityServices(input);
    expect(services.identity.image).toBe(IDENTITY_IMAGES.keycloak);
    expect(services['identity-database'].environment.POSTGRES_PASSWORD_FILE).toBe('/run/identity/database-password');
    expect(services.identity.environment).not.toHaveProperty('KC_DB_PASSWORD');
    expect(services.identity.command).toContain('--http-enabled=false');
    expect(services.identity).not.toHaveProperty('ports');
    expect(services['identity-database']).not.toHaveProperty('ports');
  });
  it.each(['http://identity.test', 'https://user:pass@identity.test', 'https://identity.test/realm', 'https://identity.test/?query=1'])('rejects unsafe origin %s', publicUrl => {
    expect(() => managedIdentityServices({ ...input, publicUrl })).toThrow();
  });
  it.each(['/', '../data', '/data/../etc', '/data/$unsafe'])('rejects unsafe custody root %s', stateRoot => {
    expect(() => managedIdentityServices({ ...input, stateRoot })).toThrow();
  });
});
