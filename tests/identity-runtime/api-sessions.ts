import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { Hono } from 'hono';
import { createApplicationSession, createWorkloadCredentials, discoverSigningKeys } from '@treeseed/identity';
import { BROWSER_SESSION_PERMISSION, BROWSER_SESSION_SCOPE } from '@treeseed/sdk/identity';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';
import { AUTH_SCHEMA_SQL } from '../../.fixtures/api/dist/api/auth/postgres-store.js';
import { createIdentityAuthenticator } from '../../.fixtures/api/dist/api/auth/identity-authenticator.js';
import { createApiIdentityRuntime } from '../../.fixtures/api/dist/api/auth/browser/runtime.js';
import { BrowserSessionStore } from '../../.fixtures/api/dist/api/auth/browser/session-store.js';
import { createBrowserIdentityService } from '../../.fixtures/api/dist/api/auth/browser/service.js';
import { installApiIdentityRoutes } from '../../.fixtures/api/dist/api/auth/browser/api-routes.js';
import { controlPlaneOperations } from '../../.fixtures/api/dist/api/control-plane/catalog/index.js';
import { OperationRegistry } from '../../.fixtures/api/dist/api/control-plane/catalog/operation-registry.js';
import { planIdentityMappings } from '../../.fixtures/api/dist/api/auth/identity-mapping-plan.js';
import { applyIdentityMappings } from '../../.fixtures/api/dist/api/auth/identity-mapping-transaction.js';
import { planIdentityWorkloads } from '../../.fixtures/api/dist/api/auth/identity/workload-plan.js';
import { applyIdentityWorkloads } from '../../.fixtures/api/dist/api/auth/identity/workload-transaction.js';
import type { startSharedDatabase } from './database.js';
import type { importPKCS8 } from 'jose';

/** Real accepted API modules and migrations. Only enrollment fixtures and the
 * disposable HTTP host are test code; no parallel session implementation. */
export async function apiSessions(root: string) {
  let pool: pg.Pool | undefined, resource = '';
  let authenticate: ReturnType<typeof createIdentityAuthenticator> | undefined;
  const services = new Map<string, Awaited<ReturnType<typeof createBrowserIdentityService>>>();
  const app = new Hono();
  let registeredIssuer: string | undefined;
  const server = createServer({ key: readFileSync(join(root, 'tls/key.pem')), cert: readFileSync(join(root, 'tls/cert.pem')) }, async (request, response) => {
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert.ok(length <= 16384); chunks.push(chunk); }
      const headers = new Headers();
      for (const [key,value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const result = await app.fetch(new Request(new URL(request.url ?? '/', resource), {
        method: request.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end('Session bridge failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); resource = `https://127.0.0.1:${address.port}`;
  const database = { transaction: async <T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    assert.ok(pool); const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const codec = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', {
    id: 'disposable-browser-session', version: 1, key: randomBytes(32),
  }));
  const first = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    assert.ok(pool); let index = 0;
    // Test-only account enrollment after the real verifier supplies issuer/sub.
    // Production runtime is read-only over these mappings; never copy this
    // fixture enrollment adapter into a live API. No email-based adoption.
    if (sql.includes('FROM user_identities identities')) {
      const [issuer, subject] = params;
      const workload = await pool.query('SELECT id FROM identity_workloads WHERE issuer=$1 AND subject=$2', [issuer, subject]);
      const mapped = await pool.query('SELECT user_id FROM user_identities WHERE provider=$1 AND provider_subject=$2', [issuer, subject]);
      if (!workload.rowCount && !mapped.rowCount) {
        const id = createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
        await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES($1,'active','now','now') ON CONFLICT DO NOTHING", [id]);
        await pool.query("INSERT INTO user_identities(id,user_id,provider,provider_subject,created_at,updated_at) VALUES($1,$1,$2,$3,'now','now') ON CONFLICT DO NOTHING", [id,issuer,subject]);
      }
    }
    return (await pool.query(sql.replace(/\?/gu, () => `$${++index}`), params)).rows[0] ?? null;
  };
  return {
    resource,
    async migrateAccount(input: { issuer: string; subject: string; userId: string }) {
      assert.ok(pool);
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES($1,'active','before-migration','before-migration')", [input.userId]);
      const planned = async () => planIdentityMappings({
        users: (await pool!.query('SELECT id,status FROM users')).rows,
        mappings: (await pool!.query('SELECT user_id AS "userId",provider AS issuer,provider_subject AS subject FROM user_identities')).rows,
        workloads: (await pool!.query('SELECT id,issuer,subject FROM identity_workloads')).rows,
      }, [input]);
      const plan = await planned(); assert.equal(plan.operations[0]?.action, 'bind');
      await applyIdentityMappings(database, { requested: [input], inventoryDigest: plan.inventoryDigest, requestDigest: plan.requestDigest });
      const repeated = await planned(); assert.equal(repeated.operations[0]?.action, 'noop');
      await applyIdentityMappings(database, { requested: [input], inventoryDigest: repeated.inventoryDigest, requestDigest: repeated.requestDigest });
      const user = (await pool.query('SELECT id,created_at FROM users WHERE id=$1', [input.userId])).rows[0];
      assert.deepEqual(user, { id: input.userId, created_at: 'before-migration' });
    },
    async provision(shared: ReturnType<typeof startSharedDatabase>) {
      const runtime = randomBytes(32).toString('hex'), migration = randomBytes(32).toString('hex');
      let phase = 'allocate';
      try {
      await shared.allocate('api', runtime, migration);
      phase = 'migrate';
      const migrator = shared.pool('api', 'migration', migration);
      try {
        for (const sql of AUTH_SCHEMA_SQL.slice(0, 3)) await migrator.query(sql);
        for (const name of ['0019_identity_browser_sessions.sql','0020_identity_workloads.sql','0021_identity_login_transactions.sql'])
          await migrator.query(readFileSync(new URL(`../../.fixtures/api/drizzle/control-plane/${name}`, import.meta.url), 'utf8'));
      } finally { await migrator.end(); }
      phase = 'activate-runtime';
      await shared.activateRuntime('api'); pool = shared.pool('api', 'runtime', runtime);
      phase = 'runtime-ddl-negative';
      await assert.rejects(pool.query('CREATE TABLE forbidden(id integer)'));
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        console.error(JSON.stringify({ apiDatabasePhase: phase, sqlState: /^[0-9A-Z_]{5,80}$/u.test(code) ? code : null,
          errorKind: error instanceof Error ? error.name : 'unknown' }));
        throw new Error('API database acceptance failed');
      }
    },
    async application(input: { issuer: string; name: string; callback: string; browserKey: Awaited<ReturnType<typeof importPKCS8>>; workloadKey: Awaited<ReturnType<typeof importPKCS8>> }) {
      assert.ok(pool);
      const { issuer, name } = input, workloadId = `${name}-bff`;
      const keys = await discoverSigningKeys({ issuer, transport: fetch });
      const runtime = await createApiIdentityRuntime({ issuer, resource, scopes: ['treeseed:read'],
        applications: [{ clientId: name, workloadPrincipalId: workloadId, redirectUri: input.callback, privateKey: input.browserKey, scopes: ['treeseed:read'] }],
        database, codec, transport: fetch, store: {
        first,
        async principalForUser(userId: string) {
          return { userId, principal: { id: userId, roles: [], permissions: [], scopes: ['treeseed:read'] } };
        },
      } });
      authenticate = runtime.authenticate;
      for (const [id, service] of runtime.services) services.set(id, service);
      if (registeredIssuer) assert.equal(issuer, registeredIssuer);
      else {
        installApiIdentityRoutes(app, { ...runtime, services, authenticate: token => {
          assert.ok(authenticate); return authenticate(token);
        } }, { registry: new OperationRegistry([controlPlaneOperations.require('status.show')]) });
        registeredIssuer = issuer;
        const metadata = await (await fetch(`${resource}/.well-known/oauth-protected-resource`)).json();
        assert.deepEqual(metadata.authorization_servers, [issuer]); assert.equal(metadata.resource, resource);
      }
      const workload = await createWorkloadCredentials({ issuer, clientId: workloadId, privateKey: input.workloadKey,
        resources: [resource], profile: 'keycloak', verificationKey: keys, transport: fetch,
        resolvePrincipal: async () => ({ principalId: workloadId, kind: 'service', clientId: workloadId }) });
      // Explicit disposable enrollment before application requests. Subsequent
      // credential reads cannot overwrite API identity or authorization.
      const verified = await workload.credentials({ resource, scopes: [BROWSER_SESSION_SCOPE] });
      const requested = [{ id: workloadId, issuer, subject: verified.principal.identity.subject, clientId: workloadId,
        displayName: workloadId, permissions: [BROWSER_SESSION_PERMISSION], scopes: [BROWSER_SESSION_SCOPE] }];
      const plan = async () => planIdentityWorkloads({
        workloads: (await pool!.query(`SELECT id,issuer,subject,client_id AS "clientId",display_name AS "displayName",status,permissions,scopes FROM identity_workloads`)).rows,
        humans: (await pool!.query(`SELECT users.id AS "userId",COALESCE(provider,'') AS issuer,COALESCE(provider_subject,'') AS subject FROM users LEFT JOIN user_identities ON users.id=user_identities.user_id`)).rows,
      }, requested);
      const initial = await plan();
      // Federation, outage and recovery checks initialize these same apps
      // again. Their exact existing registration must remain a noop.
      assert.equal((await applyIdentityWorkloads(database, { ...initial, requested })).operations[0]?.action, initial.operations[0]?.action);
      assert.equal((await applyIdentityWorkloads(database, { ...await plan(), requested })).operations[0]?.action, 'noop');
      return createApplicationSession({ issuer, resource, callbackUrl: input.callback, afterLogin: '/me', cookieName: '__Host-session',
        credentials: { token: async request => (await workload.credentials(request)).accessToken }, transport: fetch });
    },
    async verifyStorage(handles: string[]) {
      assert.ok(pool);
      const rows = (await pool.query('SELECT * FROM identity_browser_sessions')).rows;
      assert.ok(rows.length >= 2);
      const imported = (await pool.query("SELECT s.user_id,u.created_at FROM identity_browser_sessions s JOIN users u ON u.id=s.user_id WHERE u.created_at='before-migration'")).rows;
      assert.ok(imported.length >= 2, 'both applications must authenticate the existing mapped account');
      for (const row of imported) assert.equal(row.user_id, 'sovereign-existing-human');
      const serialized = JSON.stringify(rows);
      for (const handle of handles) assert.equal(serialized.includes(handle), false);
      assert.equal(serialized.includes('accessToken'), false); assert.equal(serialized.includes('refreshToken'), false);
      assert.equal((await pool.query('SELECT * FROM identity_login_transactions')).rowCount, 0);
      assert.equal(await new BrowserSessionStore(database, codec, 'unregistered').use(handles[0]!, async () => ({ result: true })), null);
      return ['real-api-encrypted-bff', 'api-shared-postgres-runtime-role', 'bff-workload-authentication', 'encrypted-session-handles', 'consumed-pkce-state', 'cross-client-session-denied', 'existing-user-id-preserved-through-login', 'identity-mapping-repeat-noop'];
    },
    async close() { await pool?.end(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
