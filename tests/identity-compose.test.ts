import { describe, expect, it } from 'vitest';
import { managedIdentityServices, IDENTITY_IMAGES } from '../src/identity/compose.js';

const input = { publicUrl: 'https://identity.example.test', configurationRoot: '/run/treeseed/identity', database: { hostname: 'postgres', port: 5432, database: 'identity', username: 'identity' } };
describe('managed identity services', () => {
  it('uses immutable images, independent PostgreSQL and protected file inputs', () => {
    const services = managedIdentityServices(input);
    expect(services.identity.image).toBe(IDENTITY_IMAGES.keycloak);
    expect(services).not.toHaveProperty('identity-database');
    expect(services.identity.environment.KC_DB_URL).toContain('sslmode=verify-full');
    expect(services.identity.environment).not.toHaveProperty('KC_DB_PASSWORD');
    expect(services.identity.command).toContain('--http-enabled=false');
    expect(services.identity.command).toContain('--spi-connections-jpa--quarkus--migration-strategy=validate');
    expect(services.identity.command).toContain('--spi-connections-jpa--quarkus--initialize-empty=false');
    expect(services.identity).not.toHaveProperty('ports');
  });
  it('permits schema changes only in the explicit migration phase', () => {
    expect(managedIdentityServices({ ...input, databasePhase: 'migration' }).identity.command).toContain('--spi-connections-jpa--quarkus--migration-strategy=update');
  });
  it('uses protected shared allocation files without a database URL in Compose', () => {
    const service = managedIdentityServices({ ...input, database: { allocationRoot: '/run/treeseed/postgres/identity' } }).identity;
    expect(service.environment).not.toHaveProperty('KC_DB_URL');
    expect(service.environment).not.toHaveProperty('KC_DB_USERNAME');
    expect(service.entrypoint[2]).toContain('/run/treeseed/postgres/identity/jdbc-url');
    expect(service.entrypoint[2]).toContain('/run/treeseed/postgres/identity/password');
    expect(service.environment.KC_HTTP_MANAGEMENT_HOST).toBe('127.0.0.1');
    expect(service.healthcheck.test.join(' ')).toContain('/health/ready');
    expect(() => managedIdentityServices({ ...input, database: { allocationRoot: '/tmp/other' } })).toThrow();
  });
  it.each(['http://identity.test', 'https://user:pass@identity.test', 'https://identity.test/realm', 'https://identity.test/?query=1'])('rejects unsafe origin %s', publicUrl => {
    expect(() => managedIdentityServices({ ...input, publicUrl })).toThrow();
  });
  it.each(['/', '../data', '/data/../etc', '/data/$unsafe'])('rejects unsafe custody root %s', configurationRoot => {
    expect(() => managedIdentityServices({ ...input, configurationRoot })).toThrow();
  });
  it('rejects absent, administrative or injectable database allocations', () => {
    for (const database of [undefined, { ...input.database, username: 'postgres' }, { ...input.database, database: 'identity?sslmode=disable' }, { ...input.database, port: 0 }]) {
      expect(() => managedIdentityServices({ ...input, database } as never)).toThrow();
    }
  });
});
