import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hostReceiptSchema, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
export const reconcileLockPath = '/run/treeseed/manager/reconcile.lock';
const reconcileExecutable = fileURLToPath(new URL('../bin/reconcile.js', import.meta.url));

export type ReconcileFailurePolicy = 'rollback' | 'halt';
export function reconcileFailurePolicy(value: unknown): ReconcileFailurePolicy {
	if (value === undefined || value === 'rollback') return 'rollback';
	if (value === 'halt') return 'halt';
	throw new Error('Reconciliation failure policy must be rollback or halt.');
}
/** A failed change must never revive a component the operator explicitly disabled. */
export function failurePolicyForDisabledComponents(requested: ReconcileFailurePolicy, disabledPreviouslyActive: boolean): ReconcileFailurePolicy {
	return disabledPreviouslyActive ? 'halt' : requested;
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
		reconcileLockPath,
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

const lifecycleResultSchema = z.object({ state: z.enum(['running', 'stopped']), changed: z.boolean(), receipt: hostReceiptSchema.optional() }).strict();
export async function serializedHostLifecycle(action: 'start' | 'stop') {
	const { stdout } = await execFileAsync('/usr/bin/flock', [
		'--exclusive', '--close', '--wait', '3500', reconcileLockPath,
		process.execPath, reconcileExecutable, `--host-action=${action}`,
	], { maxBuffer: 1024 * 1024 });
	return lifecycleResultSchema.parse(JSON.parse(stdout.trim()) as unknown);
}

const stageResultSchema = z.object({ staged: z.literal(true), configurationId: z.string(), generation: z.number().int(), lifecycle: z.literal('stopped') }).strict();
export async function serializedHostConfigurationStage(configuration: HostConfiguration) {
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn('/usr/bin/flock', [
			'--exclusive', '--close', '--wait', '3500', reconcileLockPath,
			process.execPath, reconcileExecutable, '--host-action=stage',
		], { stdio: ['pipe', 'pipe', 'pipe'] });
		let output = '', errorOutput = '';
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString('utf8');
			if (Buffer.byteLength(next, 'utf8') > 1024 * 1024) child.kill('SIGKILL');
			return next;
		};
		child.stdout.on('data', (chunk: Buffer) => { output = append(output, chunk); });
		child.stderr.on('data', (chunk: Buffer) => { errorOutput = append(errorOutput, chunk); });
		child.on('error', reject);
		child.on('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`Serialized configuration stage failed (${signal ?? `exit ${code ?? 'unknown'}`}): ${errorOutput.trim()}`)));
		child.stdin.end(JSON.stringify(configuration));
	});
	return stageResultSchema.parse(JSON.parse(stdout.trim()) as unknown);
}
