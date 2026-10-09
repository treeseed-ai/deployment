import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { isSafeDevelopmentError, supervisorConnectionHandler } from '../src/supervisor/server.js';
import { recoverAiWithoutBlockingManagement } from '../src/manager/api.js';
import { providerVolumeMappingGeometry } from '../src/security/provider-volume-expansion.js';

async function exchange(execute: (input: unknown) => unknown, operation = 'backup.list', input: Record<string, unknown> = {}) {
	const events: string[] = [];
	const details: Record<string, unknown>[] = [];
	const server = createServer({ allowHalfOpen: true }, supervisorConnectionHandler(execute, (name, value) => { events.push(name); details.push(value ?? {}); }));
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener.');
	const client = createConnection(address.port, '127.0.0.1');
	let output = ''; client.setEncoding('utf8'); client.on('data', chunk => { output += chunk; });
	try {
		await once(client, 'connect');
		client.end(JSON.stringify({ ...input, operation }));
		await once(client, 'end');
		return { response: JSON.parse(output), events, details };
	} finally { client.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('supervisor asynchronous completion', () => {
	it('retains bounded provider mapping denial facts through the native supervisor transport without exposing raw status', async () => {
		const privateValue = 'private-command-value-not-for-evidence';
		for (const [type, mode, expectedType, expectedMode] of [
			['LUKS1', 'read/write', 'LUKS1', 'read/write'],
			['LUKS2', 'readonly', 'LUKS2', 'readonly'],
			[privateValue, privateValue, 'unknown', 'unknown'],
		] as const) {
			const status = `type: ${type}\nmode: ${mode}\ndevice: /dev/loop17\noffset: 32768 sectors\nprivate: ${privateValue}\n`;
			const result = await exchange(() => providerVolumeMappingGeometry(status), 'configuration.replace');
			expect(result.response).toEqual({ ok: false, error: 'operation_failed', operation: 'configuration.replace' });
			expect(result.events).toEqual(['supervisor.operation-failed']);
			expect(result.details).toEqual([{ operation: 'configuration.replace',
				message: `Provider mapping is not writable LUKS2 (type=${expectedType}, mode=${expectedMode}).` }]);
			expect(JSON.stringify(result)).not.toContain(privateValue);
		}
	});
	it('identifies the failed component without copying request credentials into diagnostics', async () => {
		const result = await exchange(() => { throw new Error('Secret custody: unsafe_directory'); }, 'component.configure', { componentId: 'postgres', credentials: 'not-for-evidence' });
		expect(result.details).toEqual([{ operation: 'component.configure', componentId: 'postgres', message: 'Secret custody: unsafe_directory' }]);
		expect(result.response).not.toHaveProperty('message');
		expect((await exchange(() => null, 'component.configure', { componentId: 'malformed/private' })).details).toEqual([{ operation: 'component.configure' }]);
	});
	it('permits only bounded development diagnostics including numeric inventory counts', () => {
		expect(isSafeDevelopmentError('Managed development application startup failed (API_ENTRYPOINT_MIG_PENDING_2_UNEXPECTED_1).')).toBe(true);
		expect(isSafeDevelopmentError('Managed development diagnostic failed (DATABASE_INVALID_JSON).')).toBe(true);
		expect(isSafeDevelopmentError('Managed development application startup failed (private detail).')).toBe(false);
	});
	it('returns a fixed migration diagnostic while retaining private output', async () => {
		const result = await exchange(() => { throw new Error('Managed development diagnostic failed (DATABASE_INVALID_JSON).'); }, 'development.postgres.migrate');
		expect(result.response).toEqual({ ok: false, error: 'operation_failed', operation: 'development.postgres.migrate', message: 'Managed development diagnostic failed (DATABASE_INVALID_JSON).' });
	});
	it('keeps management available when AI startup recovery fails', async () => {
		const events: unknown[] = [];
		await expect(recoverAiWithoutBlockingManagement(async () => { throw new Error('private runtime detail'); }, (name, details) => { events.push({ name, details }); })).resolves.toBeUndefined();
		expect(events).toEqual([{ name: 'manager.ai-recovery-failed', details: { code: 'ai_runtime_reconciliation_required' } }]);
	});
	it('keeps a half-closed request open until the backup result resolves', async () => {
		const result = await exchange(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			return [{ generation: 219, valid: true }];
		});
		expect(result.response).toEqual({ ok: true, result: [{ generation: 219, valid: true }] });
		expect(result.events).toEqual(['supervisor.operation-complete']);
	});
	it('reports delayed failure instead of success and redacts the exception', async () => {
		const result = await exchange(async () => {
			await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('private archive detail');
		});
		expect(result.response).toEqual({ ok: false, error: 'operation_failed', operation: 'backup.list' });
		expect(result.events).toEqual(['supervisor.operation-failed']);
	});
	it('preserves synchronous operations', async () => {
		expect((await exchange(() => ({ ready: true }))).response).toEqual({ ok: true, result: { ready: true } });
	});
});
