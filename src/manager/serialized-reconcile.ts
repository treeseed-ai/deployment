import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hostReceiptSchema, type HostReceipt } from '@treeseed/sdk/deployment';

const execFileAsync = promisify(execFile);
const lockPath = '/run/treeseed/manager/reconcile.lock';
const reconcileExecutable = fileURLToPath(new URL('../bin/reconcile.js', import.meta.url));

export type ReconcileFailurePolicy = 'rollback' | 'halt';
export function reconcileFailurePolicy(value: unknown): ReconcileFailurePolicy {
	if (value === undefined || value === 'rollback') return 'rollback';
	if (value === 'halt') return 'halt';
	throw new Error('Reconciliation failure policy must be rollback or halt.');
}
export function requireAutomaticRollback(policy: ReconcileFailurePolicy) {
	if (reconcileFailurePolicy(policy) === 'halt') throw Object.assign(new Error('Reconciliation halted with affected components stopped; explicit recovery is required. Previous packages and data were not restored.'), {code:'reconcile_halted'});
}

export function serializedReconcileArguments(track?: 'stable' | 'development', forceMetadata = false, componentIds: readonly string[] = [], failurePolicy: ReconcileFailurePolicy = 'rollback') {
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
		...(reconcileFailurePolicy(failurePolicy) === 'halt' ? ['--failure-policy=halt'] : []),
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
	componentIds: readonly string[] = [], failurePolicy: ReconcileFailurePolicy = 'rollback'): Promise<HostReceipt | undefined> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync('/usr/bin/flock', serializedReconcileArguments(track, forceMetadata, componentIds, failurePolicy), { maxBuffer: 1024 * 1024 }));
	} catch (error) {
		throw reconcileExecutionError(error);
	}
	const value = JSON.parse(stdout.trim()) as unknown;
	return value === null ? undefined : hostReceiptSchema.parse(value);
}
