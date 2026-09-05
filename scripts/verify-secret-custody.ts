import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as pause } from 'node:timers/promises';
import { OpenBaoCustody, secretPath } from '../src/security/custody/index.js';

// Disposable TLS integration only: never connects to an installed host vault.
const binary = process.env.TREESEED_TEST_OPENBAO_BINARY;
if (!binary) throw new Error('TREESEED_TEST_OPENBAO_BINARY must select the verified test binary.');
const root = mkdtempSync(join(tmpdir(), 'treeseed-custody-live-'));
const listener = createServer();
await new Promise<void>((accept, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', accept); });
const port = (listener.address() as { port: number }).port;
await new Promise<void>((accept, reject) => listener.close((error) => error ? reject(error) : accept()));
const rootToken = randomBytes(32).toString('hex');
const processHandle = spawn(resolve(binary), ['server', '-dev', '-dev-tls', '-dev-no-store-token',
	`-dev-tls-cert-dir=${root}`, `-dev-listen-address=127.0.0.1:${port}`],
{ env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: rootToken }, stdio: 'ignore' });
let spawnFailed = false;
processHandle.once('error', () => { spawnFailed = true; });
const address = `https://127.0.0.1:${port}`;
const initialTrust = getCACertificates('default');
try {
	const deadline = Date.now() + 20_000;
	const cert = join(root, 'vault-ca.pem');
	while (!existsSync(cert) && Date.now() < deadline && processHandle.exitCode === null && !spawnFailed) await pause(100);
	assert.ok(existsSync(cert), 'Disposable OpenBao did not generate its TLS certificate.');
	setDefaultCACertificates([...initialTrust, readFileSync(cert, 'utf8')]);
	let ready = false;
	while (!ready && Date.now() < deadline) {
		ready = await fetch(`${address}/v1/sys/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
		if (!ready) await pause(100);
	}
	assert.ok(ready, 'Disposable OpenBao did not become healthy.');
	async function request(path: string, token: string, body?: unknown) {
		return fetch(`${address}/v1/${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
			signal: AbortSignal.timeout(5000), headers: { 'x-vault-token': token, 'content-type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {}) });
	}
	const scope = { team: 'test-team', project: 'test-project', environment: 'staging', purpose: 'hosting', name: 'provider' };
	const path = secretPath(scope);
	const policy = `path "secret/data/${path}" { capabilities = ["create", "read", "update"] }
path "secret/delete/${path}" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }`;
	assert.ok((await request('sys/policies/acl/custody-test', rootToken, { policy })).ok);
	const issued = await request('auth/token/create', rootToken, { policies: ['custody-test'], no_default_policy: true, ttl: '120s', renewable: false });
	assert.ok(issued.ok);
	const token = (await issued.json() as { auth: { client_token: string } }).auth.client_token;
	const store = new OpenBaoCustody({ address, mount: 'secret', token, scopes: [scope] });
	assert.equal(await store.write(scope, { token: 'synthetic-test-value' }, 0), 1);
	assert.deepEqual(await store.read(scope), { version: 1, values: { token: 'synthetic-test-value' } });
	await assert.rejects(store.write(scope, { token: 'stale' }, 0), /openbao_http_400/u);
	assert.equal(await store.write(scope, { token: 'rotated' }, 1), 2);
	await store.tombstone(scope, 1);
	assert.equal((await store.read(scope))?.values.token, 'rotated');
	await store.tombstone(scope, 2);
	assert.equal(await store.read(scope), null);
	for (const field of ['team', 'project', 'environment', 'purpose', 'name']) {
		const outside = secretPath({ ...scope, [field]: 'different' });
		assert.equal((await request(`secret/data/${outside}`, token)).status, 403);
	}
	await store.close();
	assert.equal((await request(`secret/data/${path}`, token)).status, 403);
	console.log(JSON.stringify({ ok: true, backend: 'openbao', tls: 'verified',
		checks: ['cas', 'rotation', 'versioned-deletion', 'five-scope-server-policy-denials', 'token-revocation'] }));
} finally {
	setDefaultCACertificates(initialTrust);
	if (processHandle.exitCode === null && !spawnFailed) {
		processHandle.kill('SIGTERM');
		await Promise.race([new Promise<void>((accept) => processHandle.once('exit', () => accept())), pause(5000, undefined, { ref: false })]);
		if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
	}
	rmSync(root, { recursive: true, force: true });
}
