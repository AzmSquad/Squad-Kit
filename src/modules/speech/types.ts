/**
 * Speech to text: the written text of a voice or video note, so agents (which read but cannot listen) know what was
 * said. Each service is one module behind this interface (ADR-002).
 */

export interface Speech {
  readonly name: string;
  /** For people, for example "Munsit". */
  readonly label: string;
  /** The words in an audio file. Long notes come back as lines with their time, so agents can point at a moment. */
  transcribe(audio: string): Promise<string>;
}

export interface SpeechModule {
  name: string;
  label: string;
  /** The service for a project folder, or null when no key is saved. A given key or fetch is used instead (tests). */
  open(root: string, opts?: { key?: string; fetch?: typeof fetch }): Speech | null;
  hasKey(root: string): boolean;
  /** Whether the service takes this key, at no cost: asked before it is saved. no-answer: it could not be asked. */
  checkKey(key: string, doFetch?: typeof fetch): Promise<'ok' | 'wrong' | 'no-answer'>;
  saveKey(root: string, key: string): void;
  removeKey(root: string): void;
}
