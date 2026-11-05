import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeAzureDevOps } from './fakes/azure-devops.js';
import { trackerContract, trackerCreateContract } from './contracts/tracker.js';
import { codeHostContract } from './contracts/code-host.js';
import { speechContract } from './contracts/speech.js';
import { Azure } from '../src/modules/azure/client.js';
import { AzureTracker } from '../src/modules/azure/tracker.js';
import { AzureRepo } from '../src/modules/azure/code-host.js';
import { munsitSpeech } from '../src/modules/munsit/speech.js';
import { AI_TOOLS } from '../src/modules/registry.js';
import { demoTracker } from '../src/board/demo-tracker.js';

/** Every product module runs the shared tests of its kind (ADR-002). */

const target = (pat: string) => ({ organization: 'momenysr', project: 'Mawid', pat });

trackerContract('Azure Boards', () => {
  const fake = fakeAzureDevOps('secret');
  return {
    tracker: new AzureTracker(new Azure(target('secret'), fake.fetch)),
    story: '40',
    comments: (id) => fake.comments.get(Number(id)) ?? [],
    refused: new AzureTracker(new Azure(target('wrong'), fake.fetch)),
  };
});

for (const process of ['Agile', 'Scrum', 'CMMI', 'Basic'] as const) {
  trackerCreateContract(`Azure Boards (${process})`, () => new AzureTracker(new Azure(target('secret'), fakeAzureDevOps('secret', { process }).fetch)));
}

trackerCreateContract('The demo tracker', () => demoTracker());

codeHostContract('Azure Repos', () => {
  const fake = fakeAzureDevOps('secret');
  return {
    host: new AzureRepo(new Azure(target('secret'), fake.fetch), 'Mawid', 'https://dev.azure.com/momenysr/Mawid/_git/Mawid'),
    clash: fake.setClash,
    refusedMessage: 'remote: TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.',
  };
});

speechContract('Munsit', () => {
  const audio = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-speech-')), 'voice.ogg');
  fs.writeFileSync(audio, 'OggS');
  const answer = (status: number, data: unknown) => (async () => new Response(JSON.stringify(data), { status })) as unknown as typeof fetch;
  const root = os.tmpdir();
  return {
    speech: munsitSpeech.open(root, { key: 'k', fetch: answer(200, { data: { transcription: 'نحتفظ بالرسائل 30 يوم' } }) })!,
    refused: munsitSpeech.open(root, { key: 'bad', fetch: answer(401, {}) })!,
    offline: munsitSpeech.open(root, {
      key: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    })!,
    audio,
  };
});

describe('every AI tool module', () => {
  for (const tool of AI_TOOLS) {
    it(`${tool.label}: says if it is ready, and describes tool calls without failing`, async () => {
      expect(typeof tool.ready()).toBe('boolean');
      expect(() => tool.describe({ name: 'SomethingNew', input: {} }, '/app')).not.toThrow();
      if (!tool.canRun) await expect(tool.run({ cwd: '/app', prompt: 'x', permissions: ['read'] })).rejects.toThrow(/cannot run/);
    });
  }
});
