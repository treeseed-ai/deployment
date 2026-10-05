import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // TypeScript is authoritative; never rediscover emitted copies under dist.
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
  },
});
