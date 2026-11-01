import fs from 'node:fs';
import path from 'node:path';
import { buildPaths } from '../../core/paths.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../../core/secrets.js';
import { ModuleError } from '../errors.js';
import type { Speech, SpeechModule } from '../speech/types.js';

/** Munsit speech to text: Egyptian and Gulf Arabic mixed with English words, the way people talk about software. */

export const MUNSIT_URL = 'https://api.munsit.com/api/v1/audio/transcribe';
const MUNSIT_MODEL = 'munsit-en-ar';

/** The person's Munsit key: MUNSIT_API_KEY, or the one saved in Settings (.squad/secrets.yaml). */
export function munsitKey(root: string): string | undefined {
  if (process.env.MUNSIT_API_KEY?.trim()) return process.env.MUNSIT_API_KEY.trim();
  try {
    return loadSecrets(buildPaths(root).secretsFile).speech?.munsit?.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface MunsitAnswer {
  data?: { transcription?: string; timestamps?: { word: string; start: number }[] };
}

/** One Munsit call. Long notes come back as lines of about 10 seconds with their time. */
export async function transcribe(audio: string, key: string, doFetch: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audio)]), path.basename(audio));
  form.append('model', MUNSIT_MODEL);
  let res: Response;
  try {
    res = await doFetch(MUNSIT_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(5 * 60_000) });
  } catch (err) {
    throw new ModuleError(`Could not reach Munsit: ${(err as Error).message}`, 'offline');
  }
  if (res.status === 401 || res.status === 403) throw new ModuleError('Munsit did not accept the key. Check it in Settings', 'sign-in', res.status);
  if (!res.ok) throw new ModuleError(`Munsit answered ${res.status}`, res.status === 429 ? 'too-many' : 'other', res.status);
  const answer = (await res.json()) as MunsitAnswer;
  const words = answer.data?.timestamps ?? [];
  const last = words[words.length - 1];
  if (last && last.start > 30) {
    const blocks = new Map<number, string[]>();
    for (const w of words) {
      const at = Math.floor(w.start / 10) * 10;
      blocks.set(at, [...(blocks.get(at) ?? []), w.word]);
    }
    return [...blocks].map(([at, ws]) => `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}  ${ws.join(' ')}`).join('\n');
  }
  const text = answer.data?.transcription?.trim();
  if (!text) throw new ModuleError('Munsit heard no words');
  return text;
}

export const munsitSpeech: SpeechModule = {
  name: 'munsit',
  label: 'Munsit',
  open(root, opts = {}): Speech | null {
    const key = opts.key ?? munsitKey(root);
    if (!key) return null;
    const doFetch = opts.fetch ?? fetch;
    return { name: 'munsit', label: 'Munsit', transcribe: (audio) => transcribe(audio, key, doFetch) };
  },
  hasKey: (root) => Boolean(munsitKey(root)),
  saveKey(root, key) {
    const file = buildPaths(root).secretsFile;
    saveSecrets(file, mergeSecrets(loadSecrets(file), { speech: { munsit: key } }));
  },
  removeKey(root) {
    const file = buildPaths(root).secretsFile;
    const secrets = loadSecrets(file);
    delete secrets.speech;
    saveSecrets(file, secrets);
  },
};
