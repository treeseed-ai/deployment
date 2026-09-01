import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hostReceiptSchema, type HostReceipt } from '@treeseed/sdk/deployment';

const execFileAsync = promisify(execFile);
const lockPath = '/run/treeseed/manager/reconcile.lock';
const reconcileExecutable = fileURLToPath(new URL('../bin/reconcile.js', import.meta.url));

export function serializedReconcileArguments(track?: 'stable' | 'development', forceMetadata = false, componentIds: readonly string[] = []) {
	return [
		'--exclusive',
		'--close',
		'--wait',
		'3500',
		lockPath,
		process.execPath,
		reconcileExecutable,
		...(track ? [`--track=${track}`] : []),
		...(forceMetadata ? ['--force-metadata'] : []),
		...(componentIds.length ? [`--components=${[...new Set(componentIds)].sort().join(',')}`] : []),
	];
}

export function reconcileExecutionError(error: unknown) {
	const stderr = String((error as { stderr?: unknown }).stderr ?? '');
	if (stderr.includes('host_security_initialization_required')) {
		return Object.assign(new Error('Host security initialization is required before managed component activation. Run `trsd host security initialize` and replay the accepted update.'), {
			code: 'host_security_initialization_required', status: 409,
		});
	}
	return error;
}

export async function serializedReconcile(track?: 'stable' | 'development', forceMetadata = false,
	componentIds: readonly string[] = []): Promise<HostReceipt | undefined> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync('/usr/bin/flock', serializedReconcileArguments(track, forceMetadata, componentIds), { maxBuffer: 1024 * 1024 }));
	} catch (error) {
		throw reconcileExecutionError(error);
	}
	const value = JSON.parse(stdout.trim()) as unknown;
	return value === null ? undefined : hostReceiptSchema.parse(value);
}
