import { describe, expect, it, vi } from 'vitest';
import { SourceBuildQueue } from '../src/sandbox/assignment-source-store.js';

describe('bounded source worker queue', () => {
  it('serializes work, rejects overload and advances after a failed job', async () => {
    const queue = new SourceBuildQueue(1), order: string[] = [];
    let finish!: () => void;
    const first = queue.run(async () => { order.push('first'); await new Promise<void>(resolve => { finish = resolve; }); throw new Error('failed job'); });
    const failed = expect(first).rejects.toThrow('failed job');
    const second = queue.run(async () => { order.push('second'); return 2; });
    const rejected = vi.fn(async () => undefined);
    await expect(queue.run(rejected)).rejects.toThrow('admission');
    expect(rejected).not.toHaveBeenCalled(); expect(order).toEqual(['first']);
    finish(); await failed; expect(await second).toBe(2);
    expect(order).toEqual(['first', 'second']);
    expect(await queue.run(async () => 3)).toBe(3);
  });
});
