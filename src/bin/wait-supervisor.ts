import { requestSupervisor } from '../supervisor/client.js';

let ready = false;
let lastError: unknown;
for (let attempt = 1; attempt <= 30; attempt += 1) {
	try {
		await requestSupervisor({ operation: 'supervisor.ping' });
		ready = true;
		break;
	} catch (error) {
		lastError = error;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}
if (!ready) throw new Error('TreeSeed supervisor did not accept a readiness request within 30 seconds.', { cause: lastError });
