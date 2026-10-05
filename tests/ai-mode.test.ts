import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { component, hash, host } from './fixtures.js';

const mocked = vi.hoisted(() => ({ root: '/tmp/treeseed-deployment-ai-mode-tests' }));
vi.mock('../src/core/paths.js', () => ({ paths: { managerState: mocked.root } }));
vi.mock('../src/core/events.js', () => ({ recordEvent: vi.fn() }));

function release(role: 'inference' | 'training') {
	const value = component(`ai-${role}`, 'development', role === 'inference' ? 'a' : 'b');
	const base = role === 'inference' ? ['inference-api'] : ['training-api'];
	const gpu = role === 'inference' ? ['inference-vllm'] : ['training-marker', 'training-axolotl'];
	value.runtime.services = [...new Set([...base, ...gpu])].map((composeService) => ({ id: composeService, composeService, endpoints: [] }));
	value.runtime.modeControl = { resource: 'ai-gpu', role, gate: { service: base[0]!, executable: '/usr/local/bin/treeseed-ai-gpu-gate' }, services: { base, gpu, ...(role === 'inference' ? { warm: 'inference-vllm' } : {}) } };
	value.runtimeDigest = hash(role === 'inference' ? 'a' : 'b');
	return value;
}

describe('bounded AI GPU mode authority', () => {
	beforeEach(() => rmSync(mocked.root, { recursive: true, force: true }));
	afterEach(() => rmSync(mocked.root, { recursive: true, force: true }));

	it('transitions exclusively, replays receipts, and preserves an unchanged warmed vLLM', async () => {
		const configuration = host(), releases = [release('inference'), release('training')];
		configuration.components['ai-inference'] = { enabled: true, track: 'development', aliases: {}, resources: { gpuDevices: ['0'] }, connections: {}, configuration: {} };
		configuration.components['ai-training'] = { enabled: true, track: 'development', aliases: {}, resources: { gpuDevices: ['0'] }, connections: {}, configuration: {} };
		const calls: any[] = [], gate = { inference: 'open', training: 'closed' } as Record<string, 'open' | 'closed'>, running = { inference: true, training: false }, active = { inference: 0, training: 0 };
		const dependencies = { host: () => configuration, components: () => releases, now: () => '2026-08-28T12:00:00.000Z', id: () => '11111111-1111-4111-8111-111111111111', sleep: async () => undefined,
			supervisor: async (operation: any) => { calls.push(operation); const role = operation.role as 'inference' | 'training'; if (operation.operation === 'ai.gpu.gate') { if (operation.action !== 'status') gate[role] = operation.action === 'open' ? 'open' : 'closed'; return { role, admission: gate[role], active: active[role] }; } if (operation.action === 'start') running[role] = true; if (operation.action === 'stop') running[role] = false; return { ready: running[role], running: running[role] ? [role] : [] }; },
		};
		const { requestAiMode } = await import('../src/manager/ai-mode.js');
		const first = await requestAiMode({ schemaVersion: 'treeseed.ai-mode-request/v1', target: 'sleep', idempotencyKey: 'cycle-1', drainTimeoutSeconds: 10 }, 'operator', dependencies as any);
		expect(first).toMatchObject({ state: 'succeeded', from: 'awake', to: 'sleep' });
		expect(running).toEqual({ inference: false, training: true });
		expect(calls.findIndex((item) => item.operation === 'ai.gpu.workload' && item.role === 'inference' && item.action === 'stop')).toBeLessThan(calls.findIndex((item) => item.operation === 'ai.gpu.workload' && item.role === 'training' && item.action === 'start'));
		const count = calls.length;
		expect(await requestAiMode({ schemaVersion: 'treeseed.ai-mode-request/v1', target: 'sleep', idempotencyKey: 'cycle-1' }, 'operator', dependencies as any)).toEqual(first);
		expect(calls).toHaveLength(count);
		const noop = await requestAiMode({ schemaVersion: 'treeseed.ai-mode-request/v1', target: 'sleep', idempotencyKey: 'cycle-2' }, 'operator', dependencies as any);
		expect(noop.state).toBe('succeeded');
		expect(calls.slice(count)).not.toContainEqual(expect.objectContaining({ operation: 'ai.gpu.workload', role: 'training', action: 'start' }));
	});

	it('postpones reverse transition without stopping active training', async () => {
		const configuration = host(), releases = [release('inference'), release('training')];
		for (const id of ['ai-inference', 'ai-training']) configuration.components[id] = { enabled: true, track: 'development', aliases: {}, resources: { gpuDevices: ['0'] }, connections: {}, configuration: {} };
		const calls: any[] = [], gate = { inference: 'closed', training: 'open' } as Record<string, 'open' | 'closed'>;
		const dependencies = { host: () => configuration, components: () => releases, now: () => '2026-08-28T12:00:00.000Z', id: () => crypto.randomUUID(), sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)), supervisor: async (operation: any) => { calls.push(operation); const role = operation.role as 'inference' | 'training'; if (operation.operation === 'ai.gpu.gate') { if (operation.action !== 'status') gate[role] = operation.action === 'open' ? 'open' : 'closed'; return { role, admission: gate[role], active: role === 'training' && operation.action === 'status' ? 1 : 0 }; } return { ready: operation.role === 'training' }; } };
		const { requestAiMode } = await import('../src/manager/ai-mode.js');
		await requestAiMode({ schemaVersion: 'treeseed.ai-mode-request/v1', target: 'sleep', idempotencyKey: 'initialize' }, 'operator', { ...dependencies, supervisor: async (operation: any) => { const role = operation.role as 'inference' | 'training'; if (operation.operation === 'ai.gpu.gate') { if (operation.action !== 'status') gate[role] = operation.action === 'open' ? 'open' : 'closed'; return { role, admission: gate[role], active: 0 }; } return { ready: operation.role === 'training' }; } } as any);
		const receipt = await requestAiMode({ schemaVersion: 'treeseed.ai-mode-request/v1', target: 'awake', idempotencyKey: 'active-training', drainTimeoutSeconds: 1 }, 'ai-lab', dependencies as any);
		expect(receipt).toMatchObject({ state: 'postponed', reason: 'active-training', requestedBy: 'ai-lab' });
		expect(calls).not.toContainEqual(expect.objectContaining({ operation: 'ai.gpu.workload', role: 'training', action: 'stop' }));
	});
});
