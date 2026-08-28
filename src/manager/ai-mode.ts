import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { aiModeRequestSchema, aiModeStatusSchema, aiModeTransitionReceiptSchema, type AiMode, type AiModeFingerprint, type AiModeRequest, type AiModeStatus, type AiModeTransitionReceipt, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { recordEvent } from '../core/events.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadActiveComponents } from './current-state.js';

type Role = 'inference' | 'training';
type StepId = AiModeTransitionReceipt['steps'][number]['id'];
interface StoredAiModeState { mode: AiMode | 'degraded'; fingerprint: AiModeFingerprint; activeTransition: AiModeTransitionReceipt | null; lastReceipt: AiModeTransitionReceipt | null; receipts: Record<string, AiModeTransitionReceipt> }
interface RuntimeBinding { role: Role; release: ComponentRelease; files: string[] }
interface AiModeDependencies {
	host(): HostConfiguration;
	components(): ComponentRelease[];
	supervisor<T>(operation: Parameters<typeof requestSupervisor>[0]): Promise<T>;
	now(): string;
	id(): string;
	sleep(milliseconds: number): Promise<void>;
}

const statePath = `${paths.managerState}/ai-mode/state.json`;
const defaults: AiModeDependencies = { host: loadHostConfiguration, components: loadActiveComponents, supervisor: requestSupervisor, now: () => new Date().toISOString(), id: randomUUID, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
let transitionQueue = Promise.resolve();

function bindings(dependencies: AiModeDependencies) {
	const host = dependencies.host(), releases = dependencies.components(), selected = new Map(releases.map((release) => [release.componentId, release]));
	for (const componentId of ['ai-inference', 'ai-training'] as const) if (!host.components[componentId]?.enabled || !selected.has(componentId)) throw new Error('AI GPU mode is unavailable until inference and training are enabled and active.');
	const inference = selected.get('ai-inference')!, training = selected.get('ai-training')!;
	for (const [release, role] of [[inference, 'inference'], [training, 'training']] as const) {
		const control = release.runtime.modeControl;
		if (!control || control.resource !== 'ai-gpu' || control.role !== role || control.gate?.executable !== '/usr/local/bin/treeseed-ai-gpu-gate' || control.services.gpu.length === 0) throw new Error(`Component ${release.componentId} does not declare the accepted ai-gpu ${role} contract.`);
	}
	const files = (release: ComponentRelease) => release.runtime.compose.files.map((file) => `${release.componentId}/${release.release}/${file.path}`);
	return { fingerprint: { inferenceRuntimeDigest: inference.runtimeDigest, trainingRuntimeDigest: training.runtimeDigest }, inference: { role: 'inference', release: inference, files: files(inference) }, training: { role: 'training', release: training, files: files(training) } } satisfies { fingerprint: AiModeFingerprint; inference: RuntimeBinding; training: RuntimeBinding };
}

function loadState(fingerprint: AiModeFingerprint): StoredAiModeState {
	if (!existsSync(statePath)) return { mode: 'awake', fingerprint, activeTransition: null, lastReceipt: null, receipts: {} };
	const value = JSON.parse(readFileSync(statePath, 'utf8')) as StoredAiModeState;
	return { ...value, receipts: value.receipts ?? {} };
}

function saveState(state: StoredAiModeState) {
	const entries = Object.entries(state.receipts).slice(-128);
	atomicJson(statePath, { ...state, receipts: Object.fromEntries(entries) }, 0o640);
}

function statusFrom(state: StoredAiModeState): AiModeStatus {
	return aiModeStatusSchema.parse({ schemaVersion: 'treeseed.ai-mode-status/v1', resource: 'ai-gpu', available: true, mode: state.activeTransition ? `transitioning-${state.activeTransition.to}` : state.mode, fingerprint: state.fingerprint, activeTransition: state.activeTransition, lastReceipt: state.lastReceipt });
}

function step(receipt: AiModeTransitionReceipt, id: StepId, state: 'running' | 'succeeded' | 'skipped' | 'failed', completedAt: string | null) {
	const existing = receipt.steps.find((item) => item.id === id);
	if (existing) Object.assign(existing, { state, completedAt }); else receipt.steps.push({ id, state, completedAt });
}

async function gate(binding: RuntimeBinding, action: 'open' | 'close' | 'status', dependencies: AiModeDependencies) {
	return dependencies.supervisor<{ role: Role; admission: 'open' | 'closed'; active: number }>({ operation: 'ai.gpu.gate', role: binding.role, action, files: binding.files });
}

async function workload(binding: RuntimeBinding, action: 'start' | 'stop' | 'status' | 'warm', timeout: number, dependencies: AiModeDependencies) {
	return dependencies.supervisor<{ ready: boolean; running?: string[] }>({ operation: 'ai.gpu.workload', role: binding.role, action, files: binding.files, waitTimeoutSeconds: timeout });
}

async function drain(binding: RuntimeBinding, timeoutSeconds: number, dependencies: AiModeDependencies) {
	const deadline = Date.now() + timeoutSeconds * 1_000;
	do {
		const observed = await gate(binding, 'status', dependencies);
		if (observed.admission !== 'closed') throw new Error(`${binding.role} admission reopened during drain.`);
		if (observed.active === 0) return true;
		if (Date.now() >= deadline) return false;
		await dependencies.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
	} while (true);
}

async function runStep(receipt: AiModeTransitionReceipt, state: StoredAiModeState, id: StepId, action: () => Promise<unknown>, dependencies: AiModeDependencies) {
	step(receipt, id, 'running', null); saveState(state);
	try { await action(); step(receipt, id, 'succeeded', dependencies.now()); saveState(state); }
	catch (error) { step(receipt, id, 'failed', dependencies.now()); saveState(state); throw error; }
}

async function restore(previous: AiMode, binding: ReturnType<typeof bindings>, timeout: number, dependencies: AiModeDependencies) {
	await gate(binding.inference, 'close', dependencies).catch(() => undefined);
	await gate(binding.training, 'close', dependencies).catch(() => undefined);
	if (previous === 'awake') {
		if (!await drain(binding.training, timeout, dependencies)) { await workload(binding.inference, 'stop', timeout, dependencies).catch(() => undefined); return false; }
		await workload(binding.training, 'stop', timeout, dependencies);
		await workload(binding.inference, 'start', timeout, dependencies);
		await workload(binding.inference, 'warm', timeout, dependencies);
		await gate(binding.inference, 'open', dependencies);
		return true;
	}
	if (!await drain(binding.inference, timeout, dependencies)) { await workload(binding.training, 'stop', timeout, dependencies).catch(() => undefined); return false; }
	await workload(binding.inference, 'stop', timeout, dependencies);
	await workload(binding.training, 'start', timeout, dependencies);
	await gate(binding.training, 'open', dependencies);
	return true;
}

async function ensureStableMode(target: AiMode, binding: ReturnType<typeof bindings>, timeout: number, dependencies: AiModeDependencies) {
	const blocked = target === 'awake' ? binding.training : binding.inference, admitted = target === 'awake' ? binding.inference : binding.training;
	await gate(blocked, 'close', dependencies);
	if (!await drain(blocked, timeout, dependencies)) {
		await gate(admitted, 'close', dependencies).catch(() => undefined);
		return false;
	}
	await workload(blocked, 'stop', timeout, dependencies);
	const observed = await workload(admitted, 'status', timeout, dependencies);
	if (!observed.ready) {
		await workload(admitted, 'start', timeout, dependencies);
		if (target === 'awake') await workload(admitted, 'warm', timeout, dependencies);
	}
	await gate(admitted, 'open', dependencies);
	return true;
}

async function transition(request: AiModeRequest, requestedBy: 'operator' | 'ai-lab', dependencies: AiModeDependencies) {
	const binding = bindings(dependencies), state = loadState(binding.fingerprint), replay = state.receipts[request.idempotencyKey];
	if (replay) return replay;
	if (state.activeTransition) throw new Error(`AI GPU transition ${state.activeTransition.transitionId} is already running.`);
	const fingerprintUnchanged = JSON.stringify(state.fingerprint) === JSON.stringify(binding.fingerprint);
	const previous = state.mode === 'degraded' ? (request.target === 'awake' ? 'sleep' : 'awake') : state.mode;
	const receipt = aiModeTransitionReceiptSchema.parse({ schemaVersion: 'treeseed.ai-mode-transition-receipt/v1', transitionId: dependencies.id(), idempotencyKey: request.idempotencyKey, resource: 'ai-gpu', requestedBy, from: previous, to: request.target, state: 'running', reason: null, fingerprint: binding.fingerprint, steps: [], startedAt: dependencies.now(), completedAt: null });
	state.activeTransition = receipt; state.fingerprint = binding.fingerprint; state.receipts[request.idempotencyKey] = receipt; saveState(state);
	if (previous === request.target && fingerprintUnchanged) {
		const repaired = await ensureStableMode(request.target, binding, request.drainTimeoutSeconds, dependencies).catch(() => false);
		receipt.state = repaired ? 'succeeded' : 'degraded'; receipt.reason = repaired ? null : 'recovery-failed'; receipt.completedAt = dependencies.now(); state.mode = repaired ? request.target : 'degraded'; state.activeTransition = null; state.lastReceipt = receipt; saveState(state); return receipt;
	}
	try {
		if (request.target === 'sleep') {
			await runStep(receipt, state, 'close-inference', () => gate(binding.inference, 'close', dependencies), dependencies);
			step(receipt, 'drain-inference', 'running', null); saveState(state);
			if (!await drain(binding.inference, request.drainTimeoutSeconds, dependencies)) {
				step(receipt, 'drain-inference', 'failed', dependencies.now()); await gate(binding.inference, 'open', dependencies);
				receipt.state = 'postponed'; receipt.reason = 'active-inference'; receipt.completedAt = dependencies.now(); state.activeTransition = null; state.lastReceipt = receipt; saveState(state); return receipt;
			}
			step(receipt, 'drain-inference', 'succeeded', dependencies.now()); saveState(state);
			await runStep(receipt, state, 'stop-vllm', () => workload(binding.inference, 'stop', request.drainTimeoutSeconds, dependencies), dependencies);
			await runStep(receipt, state, 'start-training', () => workload(binding.training, 'start', request.drainTimeoutSeconds, dependencies), dependencies);
			await runStep(receipt, state, 'open-training', () => gate(binding.training, 'open', dependencies), dependencies);
		} else {
			await runStep(receipt, state, 'close-training', () => gate(binding.training, 'close', dependencies), dependencies);
			step(receipt, 'drain-training', 'running', null); saveState(state);
			if (!await drain(binding.training, request.drainTimeoutSeconds, dependencies)) {
				step(receipt, 'drain-training', 'failed', dependencies.now()); await gate(binding.training, 'open', dependencies);
				receipt.state = 'postponed'; receipt.reason = 'active-training'; receipt.completedAt = dependencies.now(); state.activeTransition = null; state.lastReceipt = receipt; saveState(state); return receipt;
			}
			step(receipt, 'drain-training', 'succeeded', dependencies.now()); saveState(state);
			await runStep(receipt, state, 'stop-training', () => workload(binding.training, 'stop', request.drainTimeoutSeconds, dependencies), dependencies);
			await runStep(receipt, state, 'start-vllm', () => workload(binding.inference, 'start', request.drainTimeoutSeconds, dependencies), dependencies);
			await runStep(receipt, state, 'warm-vllm', () => workload(binding.inference, 'warm', request.drainTimeoutSeconds, dependencies), dependencies);
			await runStep(receipt, state, 'open-inference', () => gate(binding.inference, 'open', dependencies), dependencies);
		}
		receipt.state = 'succeeded'; receipt.completedAt = dependencies.now(); state.mode = request.target; state.activeTransition = null; state.lastReceipt = receipt; saveState(state); recordEvent('ai.mode.changed', { transitionId: receipt.transitionId, from: receipt.from, to: receipt.to }); return receipt;
	} catch (error) {
		step(receipt, 'rollback', 'running', null); saveState(state);
		const restored = await restore(previous, binding, request.drainTimeoutSeconds, dependencies).catch(() => false);
		step(receipt, 'rollback', restored ? 'succeeded' : 'failed', dependencies.now()); receipt.state = restored ? 'rolled-back' : 'degraded'; receipt.reason = restored ? 'transition-failed' : 'recovery-failed'; receipt.completedAt = dependencies.now(); state.mode = restored ? previous : 'degraded'; state.activeTransition = null; state.lastReceipt = receipt; saveState(state); recordEvent('ai.mode.transition-failed', { transitionId: receipt.transitionId, state: receipt.state });
		if (!restored) await Promise.all([gate(binding.inference, 'close', dependencies).catch(() => undefined), gate(binding.training, 'close', dependencies).catch(() => undefined)]);
		return receipt;
	}
}

export function aiModeStatus(dependencies: AiModeDependencies = defaults) {
	try { const binding = bindings(dependencies); return statusFrom(loadState(binding.fingerprint)); }
	catch { return aiModeStatusSchema.parse({ schemaVersion: 'treeseed.ai-mode-status/v1', resource: 'ai-gpu', available: false, mode: 'unavailable', fingerprint: null, activeTransition: null, lastReceipt: null }); }
}

export function requestAiMode(input: unknown, requestedBy: 'operator' | 'ai-lab', dependencies: AiModeDependencies = defaults) {
	const request = aiModeRequestSchema.parse(input);
	const queued = transitionQueue.then(() => transition(request, requestedBy, dependencies));
	transitionQueue = queued.then(() => undefined, () => undefined);
	return queued;
}

export async function recoverAiMode(dependencies: AiModeDependencies = defaults) {
	let binding: ReturnType<typeof bindings>;
	try { binding = bindings(dependencies); } catch { return aiModeStatus(dependencies); }
	const state = loadState(binding.fingerprint), interrupted = state.activeTransition;
	if (!interrupted) return reconcileAiMode(dependencies);
	const restored = await restore(interrupted.from, binding, 900, dependencies).catch(() => false);
	interrupted.state = restored ? 'rolled-back' : 'degraded'; interrupted.reason = restored ? 'transition-failed' : 'recovery-failed'; interrupted.completedAt = dependencies.now(); step(interrupted, 'rollback', restored ? 'succeeded' : 'failed', dependencies.now()); state.mode = restored ? interrupted.from : 'degraded'; state.activeTransition = null; state.lastReceipt = interrupted; saveState(state);
	return statusFrom(state);
}

export async function reconcileAiMode(dependencies: AiModeDependencies = defaults) {
	let binding: ReturnType<typeof bindings>;
	try { binding = bindings(dependencies); } catch { return aiModeStatus(dependencies); }
	const state = loadState(binding.fingerprint);
	if (state.activeTransition) return statusFrom(state);
	const target = state.mode === 'degraded' ? 'awake' : state.mode;
	const repaired = await ensureStableMode(target, binding, 900, dependencies);
	state.mode = repaired ? target : 'degraded'; state.fingerprint = binding.fingerprint; saveState(state);
	return statusFrom(state);
}

export function reconcileAiModeSelection(host: HostConfiguration, components: ComponentRelease[]) {
	return reconcileAiMode({ ...defaults, host: () => host, components: () => components });
}

export function aiModeActivationServices(component: ComponentRelease): string[] | undefined {
	const control = component.runtime.modeControl;
	if (!control || control.role === 'controller') return undefined;
	let mode: AiMode = 'awake';
	if (existsSync(statePath)) {
		const stored = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StoredAiModeState>;
		if (stored.mode === 'sleep') mode = 'sleep';
	}
	const admitted = control.role === 'inference' && mode === 'awake' || control.role === 'training' && mode === 'sleep';
	return [...control.services.base, ...(admitted ? control.services.gpu : [])];
}
