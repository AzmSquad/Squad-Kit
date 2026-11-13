import { describe, expect, it } from 'vitest';
import { Azure } from '../src/modules/azure/client.js';
import { AzureRepo } from '../src/modules/azure/code-host.js';
import { fakeAzureDevOps } from './fakes/azure-devops.js';
import type { PullRequestReview } from '../src/modules/code-host/types.js';

/**
 * The review in an Azure Repos pull request (ADR-007), against the in-memory Azure DevOps: never a real server. One
 * thread per note on its file and right-side line, with Azure's status; who pressed Looks right as a closed thread, never
 * a vote; and a second write that only adds what is missing.
 */

const target = { organization: 'momenysr', project: 'Mawid', pat: 'secret' };

function repo() {
  const fake = fakeAzureDevOps('secret');
  const host = new AzureRepo(new Azure(target, fake.fetch, 2000), 'Mawid', 'https://dev.azure.com/momenysr/Mawid/_git/Mawid');
  return { fake, host };
}

const REVIEW: PullRequestReview = {
  threads: [
    { key: 'MA-21#1', file: 'src/payments/charge.ts', line: 42, text: '**Reviewer** · round 1 · line 42\n\nRound once, after tax.\n\nFixed in `a3f9c21`', state: 'fixed' },
    { key: 'MA-21#2', file: 'src/bookings/release.ts', text: 'The whole file: the 15 minutes start at page open.', state: 'past' },
    { key: 'MA-21#3', text: 'Add a test for a refund.', state: 'open' },
  ],
  approval: { key: 'MA-21#looks-right', text: '**Momen** pressed Looks right on the squad-kit board. squad-kit wrote this for them: it cannot approve in their name.' },
};

describe('the review in an Azure Repos pull request', () => {
  it('puts each note on its file and line, with its status, and who pressed Looks right as a closed thread', async () => {
    const { fake, host } = repo();
    const pr = await host.openPullRequest({ source: 'squad/ma-21', target: 'main', title: 'Pay by card', description: 'x', items: [] });
    expect(await host.postReview(pr.id, REVIEW)).toEqual({ threads: 3 });
    const threads = fake.threads.get(pr.id)!;
    expect(threads).toHaveLength(4);
    const [fixed, past, open, ok] = threads;
    expect(fixed!.threadContext).toEqual({ filePath: '/src/payments/charge.ts', rightFileStart: { line: 42, offset: 1 }, rightFileEnd: { line: 42, offset: 1 } });
    expect(fixed!.status).toBe('fixed');
    expect(fixed!.comments[0]!.content).toContain('Fixed in `a3f9c21`');
    expect(fixed!.properties).toEqual({ 'squadKit.note': { $type: 'System.String', $value: 'MA-21#1' } });
    // A note about a whole file sits on the file with no line; one about the whole change is a general thread.
    expect(past!.threadContext).toEqual({ filePath: '/src/bookings/release.ts' });
    expect(past!.status).toBe('closed');
    expect(open!.threadContext).toBeUndefined();
    expect(open!.status).toBe('active');
    // A comment, not a vote: Azure keeps votes for people, and squad-kit never casts one.
    expect(ok!.status).toBe('closed');
    expect(ok!.comments[0]!.content).toContain('cannot approve in their name');
  });

  it('written again, it adds only what is missing, and leaves each thread as people left it', async () => {
    const { fake, host } = repo();
    const pr = await host.openPullRequest({ source: 'squad/ma-21', target: 'main', title: 'Pay by card', description: 'x', items: [] });
    await host.postReview(pr.id, { ...REVIEW, threads: REVIEW.threads.slice(0, 2) });
    // A person reopened the fixed one on Azure and changed nothing else.
    fake.threads.get(pr.id)![0]!.status = 'active';
    await host.postReview(pr.id, { ...REVIEW, threads: REVIEW.threads.map((t) => ({ ...t, state: 'past' as const, text: `${t.text} (again)` })) });
    const threads = fake.threads.get(pr.id)!;
    expect(threads).toHaveLength(4);
    expect(threads.map((t) => t.status)).toEqual(['active', 'closed', 'closed', 'closed']);
    expect(threads[0]!.comments[0]!.content).not.toContain('(again)');
    // The approval went in first time; the note that was missing goes in now, with its state of today.
    expect(threads[3]!.comments[0]!.content).toBe('Add a test for a refund. (again)');
  });

  it('a token that may not comment is refused in the shared words, for the story to say plainly', async () => {
    const { fake, host } = repo();
    const pr = await host.openPullRequest({ source: 'squad/ma-21', target: 'main', title: 'Pay by card', description: 'x', items: [] });
    fake.denyWrites(true);
    await expect(host.postReview(pr.id, REVIEW)).rejects.toMatchObject({ message: 'Azure DevOps did not accept the sign-in. Check it in Settings. An engineer can see why in the log.' });
  });
});
