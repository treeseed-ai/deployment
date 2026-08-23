import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { paths } from '../core/paths.js';
import { recordEvent } from '../core/events.js';
import { executeSupervisorOperation } from './execute.js';

export function createSupervisorServer() {
	if (process.getuid?.() !== 0) throw new Error('TreeSeed supervisor must run as root.');
	mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o750 });
	rmSync(paths.socket, { force: true });
	return createServer((connection) => {
		let input = '';
		connection.setEncoding('utf8');
		connection.on('data', (chunk) => {
			input += chunk;
			if (input.length > 1_048_576) connection.destroy(new Error('Supervisor request exceeds one MiB.'));
		});
		connection.on('end', () => {
			try {
				const request = JSON.parse(input) as unknown;
				executeSupervisorOperation(request);
				recordEvent('supervisor.operation-complete', { operation: (request as { operation?: unknown }).operation });
				connection.end('{"ok":true}\n');
			} catch (error) {
				recordEvent('supervisor.operation-failed', { message: error instanceof Error ? error.message : String(error) });
				connection.end(`${JSON.stringify({ ok: false, error: 'operation_failed' })}\n`);
			}
		});
	});
}

export function startSupervisor() {
	const server = createSupervisorServer();
	server.listen(paths.socket, () => chmodSync(paths.socket, 0o660));
	return server;
}
