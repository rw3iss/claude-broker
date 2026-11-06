import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/isolate-home.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
