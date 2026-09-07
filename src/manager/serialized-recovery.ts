import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reconcileLockPath } from './serialized-reconcile.js';

const execute = promisify(execFile);
export function serializedRecoveryArguments(generation: number) {
	if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('A positive recovery generation is required.');
	return ['--exclusive', '--close', '--wait', '3500', reconcileLockPath, process.execPath,
		fileURLToPath(new URL('../bin/recovery.js', import.meta.url)), `--generation=${generation}`];
}
export async function serializedRecovery(generation: number) {
	const { stdout } = await execute('/usr/bin/flock', serializedRecoveryArguments(generation), { maxBuffer: 1024 * 1024 });
	return JSON.parse(stdout.trim()) as unknown;
}
