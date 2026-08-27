import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hostReceiptSchema, type HostReceipt } from '@treeseed/sdk/deployment';

const execFileAsync = promisify(execFile);
const resetExecutable = fileURLToPath(new URL('../bin/reset.js', import.meta.url));

export function serializedResetArguments() {
	return ['--exclusive', '--close', '--wait', '3500', '/run/treeseed/manager/reconcile.lock', process.execPath, resetExecutable];
}

export async function serializedReset(): Promise<HostReceipt | undefined> {
	const { stdout } = await execFileAsync('/usr/bin/flock', serializedResetArguments(), { maxBuffer: 1024 * 1024 });
	const value = JSON.parse(stdout.trim()) as unknown;
	return value === null ? undefined : hostReceiptSchema.parse(value);
}
