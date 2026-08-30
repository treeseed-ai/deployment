import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SupervisorOperation } from '../supervisor/protocol.js';

const lockPath = '/run/treeseed/manager/reconcile.lock';
const securityExecutable = fileURLToPath(new URL('../bin/security-initialize.js', import.meta.url));
const maximumOutputBytes = 1024 * 1024;

export type SecurityInitializeOperation = Extract<SupervisorOperation, { operation: 'security.initialize' }>;

export function serializedSecurityInitializeArguments() {
	return ['--exclusive', '--close', '--wait', '3500', lockPath, process.execPath, securityExecutable];
}

export async function serializedSecurityInitialize(operation: SecurityInitializeOperation): Promise<unknown> {
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn('/usr/bin/flock', serializedSecurityInitializeArguments(), { stdio: ['pipe', 'pipe', 'pipe'] });
		let output = '', errorOutput = '';
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString('utf8');
			if (Buffer.byteLength(next, 'utf8') > maximumOutputBytes) child.kill('SIGKILL');
			return next;
		};
		child.stdout.on('data', (chunk: Buffer) => { output = append(output, chunk); });
		child.stderr.on('data', (chunk: Buffer) => { errorOutput = append(errorOutput, chunk); });
		child.on('error', reject);
		child.on('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`Serialized security initialization failed (${signal ?? `exit ${code ?? 'unknown'}`}): ${errorOutput.trim()}`)));
		child.stdin.end(JSON.stringify(operation));
	});
	return JSON.parse(stdout.trim()) as unknown;
}
