import { describe, expect, it, vi } from 'vitest';
import { closeBrokerAdmissionAndDrain } from '../src/sandbox/server.js';

describe('sandbox broker admission shutdown', () => {
	it('closes every listener before draining owned idle warm capacity', async () => {
		const events: string[] = [];
		const listener = (name: string) => ({ close(callback: (error?: Error) => void) {
			events.push(`${name}:closing`);
			queueMicrotask(() => { events.push(`${name}:closed`); callback(); });
		} });
		await closeBrokerAdmissionAndDrain([listener('manager'), listener('relay'), listener('proxy')], async () => { events.push('warm-pool:drained'); });
		expect(events).toEqual(['manager:closing', 'relay:closing', 'proxy:closing', 'manager:closed', 'relay:closed', 'proxy:closed', 'warm-pool:drained']);
	});

	it('preserves listener closure failures and never drains through an open admission boundary', async () => {
		const failure = new Error('listener close failed'), drain = vi.fn(async () => {});
		await expect(closeBrokerAdmissionAndDrain([{ close(callback) { callback(failure); } }], drain)).rejects.toBe(failure);
		expect(drain).not.toHaveBeenCalled();
	});
});
