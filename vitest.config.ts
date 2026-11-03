import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // In Vitest 4 restoreMocks only undoes vi.spyOn; mockReset also clears every vi.fn() before each test, as before.
    restoreMocks: true,
    mockReset: true,
    // Vitest 4 also fails a test that blocks on sync git calls past its timeout; the default 5s is too short for those.
    testTimeout: 20_000,
    setupFiles: ['test/support/env-isolation.ts'],
  },
});
