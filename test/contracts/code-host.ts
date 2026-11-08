import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoHost } from '../../src/modules/code-host/types.js';

/** The shared tests every code host module must pass (ADR-002). Each product runs them against its own fake. */
export interface CodeHostFixture {
  host: RepoHost;
  /** From now on newer changes in the base clash with every open pull request, or no longer do. */
  clash(on: boolean): void;
  /** What this host says when a push is refused because the branch only takes pull requests. */
  refusedMessage: string;
}

export function codeHostContract(name: string, make: () => CodeHostFixture): void {
  describe(`${name} as a code host`, () => {
    it('opens a pull request once, and finds it again on a retry', async () => {
      const { host } = make();
      const pr = await host.openPullRequest({ source: 'squad/pay-40', target: 'main', title: 'Opening hours', description: '**Done when**\n\n- saved', items: ['40'] });
      expect(pr.id).toBeTruthy();
      expect(pr.url).toMatch(/^https?:\/\//);
      expect((await host.findPullRequest('squad/pay-40'))?.id).toBe(pr.id);
      expect(await host.findPullRequest('squad/other')).toBeNull();
    });

    it('updates the description, with screenshots when it can', async () => {
      const { host } = make();
      const pr = await host.openPullRequest({ source: 'squad/pay-41', target: 'main', title: 'x', description: 'x', items: [] });
      if (host.abilities.attachImages) {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-contract-')), 'after-1.png');
        fs.writeFileSync(file, 'PNG!');
        expect(await host.attachImage(pr.id, file)).toMatch(/^https?:\/\//);
      }
      await expect(host.updateDescription(pr.id, 'new')).resolves.toBeUndefined();
    });

    it('merges a pull request that can merge', async () => {
      const { host } = make();
      const pr = await host.openPullRequest({ source: 'squad/pay-42', target: 'main', title: 'x', description: 'x', items: [] });
      expect(await host.mergeState(pr.id)).toBe('mergeable');
      expect((await host.merge(pr.id, 'Merge x')).commit).toBeTruthy();
      expect(await host.mergeState(pr.id)).toBe('merged');
    });

    it('reports a clash with the base in the shared way, and merges once it is fixed', async () => {
      const { host, clash } = make();
      const pr = await host.openPullRequest({ source: 'squad/pay-43', target: 'main', title: 'x', description: 'x', items: [] });
      clash(true);
      expect(await host.mergeState(pr.id)).toBe('clash');
      await expect(host.merge(pr.id, 'Merge x')).rejects.toMatchObject({ kind: 'clash' });
      clash(false);
      expect((await host.merge(pr.id, 'Merge x')).commit).toBeTruthy();
    });

    it('says when a pull request was closed without merging, and finds a merged one again by its branch', async () => {
      const { host } = make();
      const closed = await host.openPullRequest({ source: 'squad/pay-44', target: 'main', title: 'x', description: 'x', items: [] });
      await host.close(closed.id);
      expect(await host.mergeState(closed.id)).toBe('closed');
      const merged = await host.openPullRequest({ source: 'squad/pay-45', target: 'main', title: 'x', description: 'x', items: [] });
      await host.merge(merged.id, 'Merge x');
      // No longer open, so only the search in any state finds it.
      expect(await host.findPullRequest('squad/pay-45')).toBeNull();
      if (host.lastPullRequest) {
        expect((await host.lastPullRequest('squad/pay-45'))?.id).toBe(merged.id);
        expect(await host.lastPullRequest('squad/other')).toBeNull();
      }
    });

    it('knows when a branch only takes pull requests, and lets git sign in', () => {
      const { host, refusedMessage } = make();
      expect(host.refusedPush(refusedMessage)).toBe(true);
      expect(host.refusedPush('fatal: could not read from remote repository')).toBe(false);
      expect(typeof host.gitEnv()).toBe('object');
    });
  });
}
