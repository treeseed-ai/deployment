import { createConnection } from 'node:net';
import { paths } from '../core/paths.js';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';

export function requestSupervisor<T = unknown>(operation: SupervisorOperation): Promise<T> {
	const accepted = supervisorOperationSchema.parse(operation);
	return new Promise((resolve, reject) => {
		const connection = createConnection(paths.socket);
		let output = '';
		connection.setEncoding('utf8');
		connection.on('connect', () => connection.end(JSON.stringify(accepted)));
		connection.on('data', (chunk) => { output += chunk; });
		connection.on('error', reject);
		connection.on('end', () => {
			try {
				const response = JSON.parse(output) as { ok?: boolean; result?: T; operation?: string; message?: string };
				if (response.ok) resolve(response.result as T);
				else reject(new Error(response.message ?? `Supervisor operation ${response.operation ?? accepted.operation} failed; inspect the corresponding manager helper service.`));
			} catch (error) { reject(error); }
		});
	});
}
