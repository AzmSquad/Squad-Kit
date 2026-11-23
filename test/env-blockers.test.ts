import { describe, it, expect } from 'vitest';
import { envBlocked, envBlockerIn } from '../src/engine/env-blockers.js';

/** The exact outputs from TLP-1's log (#37). */
describe('a check that fails for a reason outside the code (#37)', () => {
  it('knows Docker is not running', () => {
    const b = envBlockerIn("unable to get image 'mysql:8.4': Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", 'php artisan test');
    expect(b?.what).toBe('Docker is not running');
    expect(b?.words).toContain('Start Docker');
  });

  it("knows PHP has no database driver, and which one", () => {
    const b = envBlockerIn('Illuminate\\Database\\QueryException: could not find driver (Connection: sqlite, SQL: select * from "users")', 'php artisan test');
    expect(b?.what).toBe('PHP has no sqlite driver');
    expect(b?.words).toContain('sudo apt install php-sqlite3');
  });

  it("knows the check's own program is not installed, and nothing else that says not found", () => {
    expect(envBlockerIn('sh: 1: pest: not found', 'pest --parallel')?.what).toBe('pest is not installed');
    expect(envBlockerIn('/bin/sh: line 1: vendor/bin/phpunit: No such file', 'vendor/bin/phpunit')).toBeNull();
    // A test that says "not found" about something else is the code's business.
    expect(envBlockerIn('sh: 1: convert: not found\nFAIL tests/image.test.ts', 'npm test')).toBeNull();
    expect(envBlockerIn('Expected 200, got 404 Not Found', 'npm test')).toBeNull();
  });

  it('looks only at failed checks', () => {
    const ok = { name: 'test', command: 'php artisan test', ok: true, output: 'could not find driver', seconds: 1 };
    const failed = { ...ok, name: 'lint', ok: false, output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' };
    expect(envBlocked([ok])).toBeNull();
    expect(envBlocked([ok, failed])?.result.name).toBe('lint');
  });
});
