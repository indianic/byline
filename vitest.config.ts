import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.RUN_INTEGRATION
      ? ['node_modules/**']
      : ['node_modules/**', 'tests/integration/**'],
    environment: 'node',
    testTimeout: process.env.RUN_INTEGRATION ? 60_000 : 5_000,
  },
});
