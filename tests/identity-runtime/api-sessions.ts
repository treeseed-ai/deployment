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
import { BrowserLoginStore } from '../../.fixtures/api/dist/api/auth/browser/login-store.js';
import { BrowserSessionStore } from '../../.fixtures/api/dist/api/auth/browser/session-store.js';
import { createBrowserIdentityService } from '../../.fixtures/api/dist/api/auth/browser/service.js';
import { installIdentityBrowserRoutes } from '../../.fixtures/api/dist/api/auth/browser/routes.js';
import type { startSharedDatabase } from './database.js';
import type { importPKCS8 } from 'jose';

/** Real accepted API modules and migrations. Only enrollment fixtures and the
 * disposable HTTP host are test code; no parallel session implementation. */
export async function apiSessions(root: string) {
  let pool: pg.Pool | undefined, resource = '';
  let authenticate: ReturnType<typeof createIdentityAuthenticator> | undefined;
  const services = new Map<string, Awaited<ReturnType<typeof createBrowserIdentityService>>>();
  const app = new Hono();
  installIdentityBrowserRoutes(app, { services, authenticate: token => {
    assert.ok(authenticate); return authenticate(token);
  } });
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
    return (await pool.query(sql.replace(/\?/gu, () => `$${++index}`), params)).rows[0] ?? null;
  };
  return {
    resource,
    async provision(shared: ReturnType<typeof startSharedDatabase>) {
      const runtime = randomBytes(32).toString('hex'), migration = randomBytes(32).toString('hex');
      await shared.allocate('api', runtime, migration);
      const migrator = shared.pool('api', 'migration', migration);
      try {
        for (const sql of AUTH_SCHEMA_SQL.slice(0, 3)) await migrator.query(sql);
        for (const name of ['0019_identity_browser_sessions.sql','0020_identity_workloads.sql','0021_identity_login_transactions.sql'])
          await migrator.query(readFileSync(new URL(`../../.fixtures/api/drizzle/control-plane/${name}`, import.meta.url), 'utf8'));
      } finally { await migrator.end(); }
      await shared.activateRuntime('api'); pool = shared.pool('api', 'runtime', runtime);
      await assert.rejects(pool.query('CREATE TABLE forbidden(id integer)'));
    },
    async application(input: { issuer: string; name: string; callback: string; browserKey: Awaited<ReturnType<typeof importPKCS8>>; workloadKey: Awaited<ReturnType<typeof importPKCS8>> }) {
      assert.ok(pool);
      const { issuer, name } = input, workloadId = `${name}-bff`;
      const keys = await discoverSigningKeys({ issuer, transport: fetch });
      authenticate = createIdentityAuthenticator({ issuer, audience: resource, verificationKey: keys, store: {
        first,
        async principalForUser(userId: string) {
          return { userId, principal: { id: userId, roles: [], permissions: [], scopes: ['treeseed:read'] } };
        },
      } });
      const service = await createBrowserIdentityService({ workloadPrincipalId: workloadId,
        sessions: new BrowserSessionStore(database, codec, name), oidc: {
          issuer, clientId: name, redirectUri: input.callback, privateKey: input.browserKey, resource, scopes: ['treeseed:read'],
          profile: 'keycloak', verificationKey: keys, transport: fetch, store: new BrowserLoginStore(database, codec, name),
          // Disposable, explicit subject mapping only; never email-based linking.
          resolvePrincipal: async identity => {
            const id = createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex');
            await pool!.query("INSERT INTO users(id,status,created_at,updated_at) VALUES($1,'active','now','now') ON CONFLICT DO NOTHING", [id]);
            await pool!.query("INSERT INTO user_identities(id,user_id,provider,provider_subject,created_at,updated_at) VALUES($1,$1,$2,$3,'now','now') ON CONFLICT DO NOTHING", [id,identity.issuer,identity.subject]);
            return { principalId: id, kind: 'human' };
          },
        } });
      services.set(workloadId, service);
      const workload = await createWorkloadCredentials({ issuer, clientId: workloadId, privateKey: input.workloadKey,
        resources: [resource], profile: 'keycloak', verificationKey: keys, transport: fetch,
        resolvePrincipal: async identity => {
          await pool!.query(`INSERT INTO identity_workloads(id,issuer,subject,client_id,display_name,status,permissions,scopes)
            VALUES($1,$2,$3,$1,$1,'active',$4::jsonb,$5::jsonb) ON CONFLICT(id) DO UPDATE SET issuer=$2,subject=$3`,
          [workloadId,issuer,identity.subject,JSON.stringify([BROWSER_SESSION_PERMISSION]),JSON.stringify([BROWSER_SESSION_SCOPE])]);
          return { principalId: workloadId, kind: 'service', clientId: workloadId };
        } });
      return createApplicationSession({ issuer, resource, callbackUrl: input.callback, afterLogin: '/me', cookieName: '__Host-session',
        credentials: { token: async request => (await workload.credentials(request)).accessToken }, transport: fetch });
    },
    async verifyStorage(handles: string[]) {
      assert.ok(pool);
      const rows = (await pool.query('SELECT * FROM identity_browser_sessions')).rows;
      assert.ok(rows.length >= 2);
      const serialized = JSON.stringify(rows);
      for (const handle of handles) assert.equal(serialized.includes(handle), false);
      assert.equal(serialized.includes('accessToken'), false); assert.equal(serialized.includes('refreshToken'), false);
      assert.equal((await pool.query('SELECT * FROM identity_login_transactions')).rowCount, 0);
      assert.equal(await new BrowserSessionStore(database, codec, 'unregistered').use(handles[0]!, async () => ({ result: true })), null);
      return ['real-api-encrypted-bff', 'api-shared-postgres-runtime-role', 'bff-workload-authentication', 'encrypted-session-handles', 'consumed-pkce-state', 'cross-client-session-denied'];
    },
    async close() { await pool?.end(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
