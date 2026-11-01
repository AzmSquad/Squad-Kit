import { describe, it, expect } from 'vitest';
import type { Speech } from '../../src/modules/speech/types.js';

/** The shared tests every speech to text module must pass (ADR-002). Each product runs them against its own fake. */
export interface SpeechFixture {
  speech: Speech;
  /** An audio file the fake hears as words. */
  audio: string;
  /** The same service with a key it refuses. */
  refused: Speech;
  /** The same service when it cannot be reached. */
  offline: Speech;
}

export function speechContract(name: string, make: () => SpeechFixture): void {
  describe(`${name} as speech to text`, () => {
    it('writes out what was said', async () => {
      const { speech, audio } = make();
      expect((await speech.transcribe(audio)).trim()).toBeTruthy();
      expect(speech.label).toBeTruthy();
    });

    it('reports a refused key and no connection in the shared way', async () => {
      const { refused, offline, audio } = make();
      await expect(refused.transcribe(audio)).rejects.toMatchObject({ kind: 'sign-in' });
      await expect(offline.transcribe(audio)).rejects.toMatchObject({ kind: 'offline' });
    });
  });
}
