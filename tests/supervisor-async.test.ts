import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { supervisorConnectionHandler } from '../src/supervisor/server.js';

async function exchange(execute: (input: unknown) => unknown) {
	const events: string[] = [];
	const server = createServer({ allowHalfOpen: true }, supervisorConnectionHandler(execute, (name) => { events.push(name); }));
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener.');
	const client = createConnection(address.port, '127.0.0.1');
	let output = ''; client.setEncoding('utf8'); client.on('data', chunk => { output += chunk; });
	try {
		await once(client, 'connect');
		client.end(JSON.stringify({ operation: 'backup.list' }));
		await once(client, 'end');
		return { response: JSON.parse(output), events };
	} finally { client.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('supervisor asynchronous completion', () => {
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
