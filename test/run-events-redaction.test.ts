import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths } from '../src/core/paths.js';
import { createRunEventsStore, redactPlannerEventForDisk } from '../src/core/run-events-store.js';
import { PlannerEventBus, type PlannerEvent } from '../src/planner/events.js';

const AUTH_INFO: Extract<PlannerEvent, { kind: 'auth_info' }> = {
  kind: 'auth_info',
  runId: 'r1',
  mode: 'subscription',
  reason: 'auto-login-detected',
  credentialHint: 'Claude login (macOS Keychain)',
  apiKeySource: 'oauth',
  account: {
    email: 'planner@example.com',
    organization: 'Example Org',
    subscriptionType: 'max',
  },
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-run-events-redaction-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('redactPlannerEventForDisk', () => {
  it('keeps mode, reason, credentialHint, and apiKeySource but drops the account block', () => {
    const redacted = redactPlannerEventForDisk(AUTH_INFO) as Extract<PlannerEvent, { kind: 'auth_info' }>;
    expect(redacted).toEqual({
      kind: 'auth_info',
      runId: 'r1',
      mode: 'subscription',
      reason: 'auto-login-detected',
      credentialHint: 'Claude login (macOS Keychain)',
      apiKeySource: 'oauth',
    });
    expect('account' in redacted).toBe(false);
  });

  it('still blanks thinking text', () => {
    const redacted = redactPlannerEventForDisk({
      kind: 'thinking_delta',
      runId: 'r1',
      turn: 1,
      blockIndex: 0,
      delta: 'private reasoning',
    });
    expect(redacted).toMatchObject({ kind: 'thinking_delta', delta: '' });
  });
});

describe('persisted auth_info', () => {
  it('writes no account fields and no credential material to JSONL', async () => {
    const paths = buildPaths(tmp);
    const store = createRunEventsStore(paths, 'r1');
    await store.append(AUTH_INFO);
    await store.close();

    const file = path.join(tmp, '.squad', 'runs', 'r1.events.jsonl');
    const raw = fs.readFileSync(file, 'utf8');

    expect(raw).not.toContain('planner@example.com');
    expect(raw).not.toContain('Example Org');
    expect(raw).not.toContain('subscriptionType');
    expect(raw).not.toContain('account');
    expect(raw).toContain('"apiKeySource":"oauth"');
    expect(raw).toContain('"mode":"subscription"');
  });

  it('leaves the live bus event untouched', () => {
    const bus = new PlannerEventBus();
    const seen: PlannerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.emit(AUTH_INFO);
    expect(seen[0]).toMatchObject({ account: { email: 'planner@example.com' } });
  });
});
