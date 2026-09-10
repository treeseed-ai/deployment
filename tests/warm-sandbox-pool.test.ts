import { describe, expect, it, vi } from 'vitest';
import { WarmSandboxPool } from '../src/sandbox/warm-sandbox-pool.js';

const shape = { image: 'trusted@sha256:fixture', cpuCores: 1, memoryBytes: 1024 };
function fixture() {
	let count = 0;
	const operations = { create: vi.fn(async () => `vm-${++count}`), destroy: vi.fn(async (_id: string) => undefined), onFailure: vi.fn() };
	return { operations, pool: new WarmSandboxPool(operations) };
}
describe('one-use pristine warm sandbox pool', () => {
	it('atomically assigns each VM once, replenishes only pristine capacity and bounds idle memory', async () => {
		const { pool, operations } = fixture(); pool.prewarm(shape); pool.prewarm(shape);
		expect(operations.create).toHaveBeenCalledTimes(1);
		const results = await Promise.all([pool.acquire(shape), pool.acquire(shape)]);
		expect(new Set(results.map(result => result.id)).size).toBe(2);
		expect(results.map(result => result.warmed)).toEqual([true, false]);
		await pool.drain(); expect(operations.destroy).toHaveBeenCalledTimes(1);
		expect(results.map(result => result.id)).not.toContain(operations.destroy.mock.calls[0]?.[0]);
	});
	it('never substitutes an incompatible image or resource shape', async () => {
		const { pool } = fixture(); pool.prewarm(shape);
		expect((await pool.acquire({ ...shape, image: 'other' })).warmed).toBe(false);
		expect((await pool.acquire(shape)).warmed).toBe(true);
		await pool.drain();
	});
	it('does not recycle failed readiness and rejects admission after drain', async () => {
		const { pool, operations } = fixture(); operations.create.mockRejectedValueOnce(new Error('not ready'));
		pool.prewarm(shape); await Promise.resolve(); await Promise.resolve();
		expect(operations.onFailure).toHaveBeenCalledTimes(1);
		expect((await pool.acquire(shape)).warmed).toBe(false);
		await pool.drain(); await expect(pool.acquire(shape)).rejects.toThrow('stopped');
	});
	it('destroys creation that finishes after admission has stopped', async () => {
		const { pool, operations } = fixture(); let complete!: (value: string) => void;
		operations.create.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
		const pending = pool.acquire(shape); await pool.drain(); complete('late');
		await expect(pending).rejects.toThrow('stopped'); expect(operations.destroy).toHaveBeenCalledWith('late');
	});
});
