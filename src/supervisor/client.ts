import { createConnection } from 'node:net';
import { paths } from '../core/paths.js';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';

export function requestSupervisor(operation: SupervisorOperation): Promise<void> {
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
				const response = JSON.parse(output) as { ok?: boolean };
				if (response.ok) resolve(); else reject(new Error('Supervisor rejected the fixed operation.'));
			} catch (error) { reject(error); }
		});
	});
}
