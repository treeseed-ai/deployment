import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { type AddressInfo } from 'node:net';
import { edgeReadiness, verifyEdgeAlias } from '../src/edge/readiness.js';

let directory: string, ca: string, server: Server, port: number;
beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'treeseed-tls-test-'));
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test.localhost', '-addext', 'subjectAltName=DNS:test.localhost', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' });
	ca = readFileSync(join(directory, 'cert'), 'utf8');
	server = createServer({ key: readFileSync(join(directory, 'key')), cert: ca }, socket => socket.end());
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true }); });
it('verifies a live listener with the trusted certificate', async () => {
	expect(await verifyEdgeAlias('test.localhost', ca, port)).toBe(true);
});
it('rejects wrong names and untrusted certificates', async () => {
	expect(await verifyEdgeAlias('wrong.localhost', ca, port)).toBe(false);
	expect(await verifyEdgeAlias('test.localhost', '', port)).toBe(false);
});
it('rejects nonlocal destinations and unavailable authority files', async () => {
	expect(await verifyEdgeAlias('example.com', ca, port)).toBe(false);
	expect(await edgeReadiness(['test.localhost'], join(directory, 'missing'))).toBe(false);
});
