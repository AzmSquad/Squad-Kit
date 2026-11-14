import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMAIL, SITE, fakeJira } from './fakes/jira.js';
import { boardPaths, readTicket, writeMeta } from '../src/board/store.js';
import { createTicket } from '../src/board/actions/new-ticket.js';
import { resolveItem, tellTracker } from '../src/engine/sync.js';
import { JiraClient } from '../src/modules/jira/client.js';
import { JiraTracker } from '../src/modules/jira/tracker.js';

/**
 * A Jira workflow with no way on stops only the move: the comment, the release label and the words that come with it
 * still reach the story, and the ticket says what Jira would not do.
 */

function board() {
  const bp = boardPaths(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jira-sync-')), '.squad'));
  writeMeta(bp, {
    project: 'Payments',
    key: 'PAY',
    nextNumber: 1,
    engine: 'live',
    user: { name: 'Sara', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
  });
  const t = createTicket(bp, { id: 'PAY-40', title: 'Hold a slot', ask: 'x', priority: 'normal', source: { type: 'jira', ref: 'PAY-40', id: 'PAY-40' } });
  return { bp, t };
}

describe('Jira updates when the workflow has no way on', () => {
  it('released: the label and "Released in" still go, and the ticket says Jira did not move it', async () => {
    const fake = fakeJira('secret', { qa: 'dead-end' });
    const tracker = new JiraTracker(new JiraClient({ site: SITE, email: EMAIL, token: 'secret' }, fake.fetch), { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', readOnly: false });
    const { bp, t } = board();
    expect(await tellTracker(bp, t.id, { kind: 'released', version: 'v1.3.22' }, tracker)).toBe(true);
    expect(fake.issues.get('PAY-40')!.labels).toContain('v1.3.22');
    expect(fake.comments('PAY-40').some((c) => c.includes('Released in'))).toBe(true);
    const notes = () => readTicket(bp, t.id)!.activity.map((a) => a.text);
    expect(notes().filter((l) => l.includes('would not move'))).toEqual(['Jira would not move PAY-40, so squad-kit went on without the move. Move it in Jira if it should go on']);
    // Closed is said only when Jira took the move.
    expect(notes().some((l) => l.startsWith('Closed PAY-40'))).toBe(false);
    expect(notes()).toContain('Posted the release on PAY-40');
    // A retry says nothing twice.
    await tellTracker(bp, t.id, { kind: 'released', version: 'v1.3.22' }, tracker, true);
    expect(notes().filter((l) => l.includes('would not move'))).toHaveLength(1);
  });

  it('released where Jira takes the move: Closed, with the status', async () => {
    const fake = fakeJira('secret');
    const tracker = new JiraTracker(new JiraClient({ site: SITE, email: EMAIL, token: 'secret' }, fake.fetch), { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', readOnly: false });
    const { bp, t } = board();
    await tellTracker(bp, t.id, { kind: 'released', version: 'v1.3.22' }, tracker);
    expect(readTicket(bp, t.id)!.activity.map((a) => a.text)).toContain('Closed PAY-40 on Jira (Done)');
  });

  it('resolved: the merge words still go on the story', async () => {
    const fake = fakeJira('secret', { qa: 'dead-end' });
    const tracker = new JiraTracker(new JiraClient({ site: SITE, email: EMAIL, token: 'secret' }, fake.fetch), { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', readOnly: false });
    const { bp, t } = board();
    await resolveItem(bp, t.id, tracker, 'PAY-40', true, 'Merged into **main**.');
    expect(fake.comments('PAY-40').some((c) => c.includes('Merged into'))).toBe(true);
  });
});
