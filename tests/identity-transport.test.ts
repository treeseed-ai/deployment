import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityTransport } from '../src/identity/transport.js';

const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-transport-'));
let server: Server, port: number, ca: string;
let observed: { host: string | undefined; cookie: string | undefined; body: string } | undefined;
beforeAll(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=identity.example.test', '-addext', 'subjectAltName=DNS:identity.example.test',
    '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' });
  ca = readFileSync(join(root, 'cert'), 'utf8');
  server = createServer({ key: readFileSync(join(root, 'key')), cert: ca }, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: 'https://other.example' }); response.end(); return; }
    if (request.url === '/large') { response.end(Buffer.alloc(1_048_577, 1)); return; }
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
      observed = { host: request.headers.host, cookie: request.headers.cookie, body };
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', 'not-for-the-browser=true');
      response.end(JSON.stringify({ issuer: 'https://identity.example.test/realms/treeseed' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  port = address.port;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true });
});
const transport = () => createIdentityTransport({ origin: 'https://identity.example.test', ca, hostname: '127.0.0.1', port });

it('preserves public issuer TLS/Host over an explicit private route and strips cookies', async () => {
  const response = await transport()('https://identity.example.test/token', { method: 'POST',
    headers: { cookie: 'must-not-cross', host: 'other.example' }, body: 'synthetic-request' });
  expect(await response.json()).toEqual({ issuer: 'https://identity.example.test/realms/treeseed' });
  expect(observed).toEqual({ host: 'identity.example.test', cookie: undefined, body: 'synthetic-request' });
  expect(response.headers.has('set-cookie')).toBe(false);
});

it('denies other origins, redirects, excessive payloads, and wrong TLS server identities', async () => {
  const fetch = transport();
  await expect(fetch('https://other.example/token')).rejects.toThrow('boundary');
  await expect(fetch('https://identity.example.test/redirect')).rejects.toThrow('redirect');
  await expect(fetch('https://identity.example.test/large')).rejects.toThrow('transport failed');
  await expect(fetch('https://identity.example.test/token', { method: 'POST', body: 'x'.repeat(1_048_577) })).rejects.toThrow('limit');
  const wrong = createIdentityTransport({ origin: 'https://wrong.example.test', ca, hostname: '127.0.0.1', port });
  await expect(wrong('https://wrong.example.test/token')).rejects.toThrow('transport failed');
});

it('honors cancellation without exposing request credentials in errors', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(transport()('https://identity.example.test/token', { method: 'POST',
    body: 'synthetic-private-material', signal: controller.signal })).rejects.toThrow('Managed Identity transport failed');
});
