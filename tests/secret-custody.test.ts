import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSecretCustody, OpenBaoCustody, secretPath, type SecretScope } from '../src/security/custody/index.js';

const scope: SecretScope = { team: 'team-a', project: 'project-a', environment: 'staging', purpose: 'hosting', name: 'railway' };
const roots: string[] = [];
function local() {
	const root = mkdtempSync(join(tmpdir(), 'treeseed-custody-')); roots.push(root);
	const store = new LocalSecretCustody(root), key = randomBytes(32); store.unlock(key);
	return { root, store, key };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('exact scope', () => {
	it.each(['team', 'project', 'environment', 'purpose', 'name'] as const)('rejects traversal and wildcards in %s', (part) => {
		for (const value of ['../other', '..', 'a/b', '*', '+', '%2f', '', 'a?b', 'a\nb'])
			expect(() => secretPath({ ...scope, [part]: value })).toThrow('invalid_scope');
	});
});

describe('OS-key local custody', () => {
	it('encrypts with restrictive permissions, real locking and key isolation', () => {
		const { store, key, root } = local();
		expect(store.write(scope, { apiToken: 'not-public' }, 0)).toBe(1);
		const file = join(root, readdirSync(root)[0]!);
		expect(readFileSync(file).includes('not-public')).toBe(false);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		key.fill(0); // Unlock copied the OS-supplied material, never retained the caller's buffer.
		expect(store.read(scope)).toEqual({ version: 1, values: { apiToken: 'not-public' } });
		store.lock(); expect(store.locked).toBe(true);
		expect(() => store.read(scope)).toThrow('locked');
		expect(() => store.write(scope, { apiToken: 'new' }, 1)).toThrow('locked');
		store.unlock(randomBytes(32)); expect(() => store.read(scope)).toThrow('invalid_record');
	});

	it('requires CAS for creation and rotation, preserves state on conflicts', () => {
		const { store } = local();
		expect(store.read(scope)).toBeNull();
		expect(() => store.write(scope, { token: 'one' }, 1)).toThrow('version_conflict');
		store.write(scope, { token: 'one' }, 0);
		expect(() => store.write(scope, { token: 'two' }, 0)).toThrow('version_conflict');
		expect(store.write(scope, { token: 'two' }, 1)).toBe(2);
		expect(store.read(scope)?.values.token).toBe('two');
	});

	it.each(['team', 'project', 'environment', 'purpose', 'name'] as const)('binds ciphertext to %s', (part) => {
		const { store, root } = local();
		store.write(scope, { token: 'original' }, 0);
		const first = readdirSync(root)[0]!;
		const other = { ...scope, [part]: 'other' }; store.write(other, { token: 'other' }, 0);
		const second = readdirSync(root).find((name) => name !== first)!;
		copyFileSync(join(root, first), join(root, second));
		expect(() => store.read(other)).toThrow('invalid_record');
	});

	it('rejects malformed/tampered records, plaintext, symlinks and permissive custody', () => {
		const { store, root } = local(); store.write(scope, { token: 'original' }, 0);
		const file = join(root, readdirSync(root)[0]!);
		writeFileSync(file, 'plaintext'); expect(() => store.read(scope)).toThrow('invalid_record');
		rmSync(file); symlinkSync(join(root, 'missing'), file);
		expect(() => store.read(scope)).toThrow('unsafe_record');
		chmodSync(root, 0o755); expect(() => store.read(scope)).toThrow('unsafe_directory');
	});

	it('rejects a concurrent writer without deleting its lock', () => {
		const { store, root } = local(); store.write(scope, { token: 'one' }, 0);
		const lock = join(root, `${readdirSync(root)[0]!}.lock`); writeFileSync(lock, '');
		expect(() => store.write(scope, { token: 'two' }, 1)).toThrow('record_busy');
		expect(readFileSync(lock, 'utf8')).toBe('');
		expect(store.read(scope)?.values.token).toBe('one');
	});
});

describe('OpenBao custody', () => {
	function client(fetchImpl: typeof fetch) { return new OpenBaoCustody({ address: 'https://bao.example', mount: 'treeseed', token: 'scoped-token', scopes: [scope], fetchImpl }); }
	it('reads exact paths and writes with explicit CAS, without redirects', async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { data: { token: 'secret' }, metadata: { version: 1 } } }))
			.mockResolvedValueOnce(Response.json({ data: { version: 2 } }));
		const store = client(request);
		expect(await store.read(scope)).toEqual({ version: 1, values: { token: 'secret' } });
		expect(await store.write(scope, { token: 'rotated' }, 1)).toBe(2);
		expect(request.mock.calls[0]![0]).toBe(`https://bao.example/v1/treeseed/data/${secretPath(scope)}`);
		expect(request.mock.calls[1]![1]).toMatchObject({ redirect: 'error', method: 'POST', body: JSON.stringify({ options: { cas: 1 }, data: { token: 'rotated' } }) });
		expect(request.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it('tombstones only a chosen version and revokes the session', async () => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
		const store = client(request); await store.tombstone(scope, 3); await store.close(); await store.close();
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0]![1]?.body).toBe(JSON.stringify({ versions: [3] }));
		expect(request.mock.calls[1]![0]).toBe('https://bao.example/v1/auth/token/revoke-self');
		await expect(store.read(scope)).rejects.toThrow('session_closed');
	});

	it('redacts server bodies and transport exceptions', async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('secret leaked by backend', { status: 403 }))
			.mockRejectedValueOnce(new Error('secret leaked by transport'));
		const store = client(request);
		await expect(store.read(scope)).rejects.toThrow('openbao_http_403');
		await expect(store.read(scope)).rejects.toThrow('openbao_request_failed');
	});

	it.each(['http://localhost', 'https://user:password@bao.example', 'https://bao.example/path', 'https://bao.example?token=secret'])('rejects unsafe address %s', (address) => {
		expect(() => new OpenBaoCustody({ address, mount: 'treeseed', token: 'token', scopes: [scope] })).toThrow('invalid_address');
	});

	it.each(['team', 'project', 'environment', 'purpose', 'name'] as const)('denies ungranted %s before making a request', async (part) => {
		const request = vi.fn<typeof fetch>(), store = client(request), other = { ...scope, [part]: 'other' };
		await expect(store.read(other)).rejects.toThrow('scope_denied');
		await expect(store.write(other, { token: 'secret' }, 0)).rejects.toThrow('scope_denied');
		await expect(store.tombstone(other, 1)).rejects.toThrow('scope_denied');
		expect(request).not.toHaveBeenCalled();
	});

	it('bounds response sizes without including secret content in the error', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
		await expect(client(request).read(scope)).rejects.toThrow('response_too_large');
	});

	it('distinguishes absence from failure and rejects malformed data', async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(Response.json({ data: { data: { token: 42 }, metadata: { version: 1 } } }));
		const store = client(request); expect(await store.read(scope)).toBeNull();
		await expect(store.read(scope)).rejects.toThrow('invalid_values');
	});
});
