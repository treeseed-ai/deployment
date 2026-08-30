import { stdin, stdout } from 'node:process';
import { requestSupervisor } from '../supervisor/client.js';
import { supervisorOperationSchema } from '../supervisor/protocol.js';

const maximumInputBytes = 128 * 1024;
let input = '';

stdin.setEncoding('utf8');
for await (const chunk of stdin) {
	input += chunk;
	if (Buffer.byteLength(input, 'utf8') > maximumInputBytes) throw new Error('Security initialization payload exceeds the allowed size.');
}

const operation = supervisorOperationSchema.parse(JSON.parse(input) as unknown);
if (operation.operation !== 'security.initialize') throw new Error('Only security.initialize is accepted by this helper.');
const result = await requestSupervisor(operation);
stdout.write(`${JSON.stringify(result)}\n`);
