import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // In Vitest 4 restoreMocks only undoes vi.spyOn; mockReset also clears every vi.fn() before each test, as before.
    restoreMocks: true,
    mockReset: true,
    // Vitest 4 also fails a test that blocks on sync git calls past its timeout. The longest ones run the whole squad
    // several times over with real git, and on a busy computer or a small CI machine that takes a while: no test here is
    // about this limit, it only catches one that hangs. GitHub's checks run these, so a slow machine must not fail a release.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['test/support/env-isolation.ts'],
    // Says once why some tests skip inside squad-kit's own guard (test/support/in-guard.ts).
    globalSetup: ['test/support/guard-note.ts'],
  },
});
