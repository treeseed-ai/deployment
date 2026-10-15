import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // TypeScript is authoritative; never rediscover emitted copies under dist.
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    // Native files share one owning containerd/Kata host and its inventories.
    // Explicit concurrency within each test remains exercised.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
