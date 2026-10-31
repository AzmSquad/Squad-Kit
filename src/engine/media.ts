import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BoardPaths } from '../board/store.js';
import { buildPaths } from '../core/paths.js';
import { loadSecrets } from '../core/secrets.js';

/**
 * Voice and video notes. Claude Code reads text and pictures but cannot listen, so squad-kit writes each note out
 * itself before an agent sees it: the words through Munsit speech to text, and for a video, pictures of the screen.
 * The results sit next to the note as ordinary attachments. Without a Munsit key the notes stay attached, unheard.
 */

export const AUDIO_FILE = /\.(ogg|opus|oga|m4a|mp3|wav|aac|amr|flac|weba)$/i;
export const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;
export const MUNSIT_URL = 'https://api.munsit.com/api/v1/audio/transcribe';
/** Egyptian and Gulf Arabic mixed with English words, the way people talk about software. */
const MUNSIT_MODEL = 'munsit-en-ar';
const MAX_NOTE_BYTES = 100 * 1024 * 1024;

export function isMediaNote(file: string): boolean {
  return AUDIO_FILE.test(file) || VIDEO_FILE.test(file);
}

export function transcriptOf(file: string): string {
  return `${file}.transcript.txt`;
}

/** The person's Munsit key: MUNSIT_API_KEY, or the one saved in Settings (.squad/secrets.yaml). */
export function munsitKey(bp: BoardPaths): string | undefined {
  if (process.env.MUNSIT_API_KEY?.trim()) return process.env.MUNSIT_API_KEY.trim();
  try {
    return loadSecrets(buildPaths(path.dirname(path.dirname(bp.dir))).secretsFile).speech?.munsit?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface MediaResult {
  /** New files to hand the agents: transcripts and pictures of the screen. */
  added: string[];
  /** One line per note for the ticket's activity. */
  notes: string[];
  /** Notes were attached but no Munsit key is saved, so nobody can hear them. */
  missingKey: boolean;
}

export interface MediaOptions {
  key?: string;
  fetch?: typeof fetch;
  /** Takes the sound out of a video. Defaults to macOS avconvert. */
  extractAudio?: (video: string, out: string) => void;
  /** Saves pictures of a video's screen and returns their paths. Defaults to AVFoundation through swift. */
  extractFrames?: (video: string, outPrefix: string) => string[];
}

/** Writes out every voice and video note in `files` that has no transcript yet. Never throws: a note that fails is reported and skipped. */
export async function prepareMedia(bp: BoardPaths, files: string[], opts: MediaOptions = {}): Promise<MediaResult> {
  const notes = files.filter((f) => isMediaNote(f) && !fs.existsSync(transcriptOf(f)));
  const result: MediaResult = { added: [], notes: [], missingKey: false };
  if (!notes.length) return result;
  const key = opts.key ?? munsitKey(bp);
  if (!key) {
    result.missingKey = true;
    result.notes.push(`${notes.length === 1 ? '1 voice or video note is' : `${notes.length} voice or video notes are`} attached, but nobody can listen to ${notes.length === 1 ? 'it' : 'them'}. Add a Munsit key in Settings`);
    return result;
  }
  for (const note of notes) {
    const name = path.basename(note);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-media-'));
    try {
      if (fs.statSync(note).size > MAX_NOTE_BYTES) throw new Error('it is larger than 100 MB');
      let audio = note;
      if (VIDEO_FILE.test(note)) {
        audio = path.join(tmp, 'sound.m4a');
        (opts.extractAudio ?? avconvert)(note, audio);
        try {
          const frames = (opts.extractFrames ?? swiftFrames)(note, `${note}.screen`);
          result.added.push(...frames);
        } catch {
          // Pictures of the screen are a bonus; the words matter more.
        }
      }
      const text = await transcribe(audio, key, opts.fetch ?? fetch);
      fs.writeFileSync(transcriptOf(note), `Transcript of ${name} (written out by Munsit speech to text, may have small mistakes):\n\n${text}\n`);
      result.added.push(transcriptOf(note));
      result.notes.push(`Wrote out ${name}`);
    } catch (err) {
      result.notes.push(`Could not write out ${name}: ${(err as Error).message}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return result;
}

interface MunsitAnswer {
  data?: { transcription?: string; timestamps?: { word: string; start: number }[] };
}

/** One Munsit call. Long notes come back as lines of about 10 seconds with their time, so agents can point at a moment. */
export async function transcribe(audio: string, key: string, doFetch: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audio)]), path.basename(audio));
  form.append('model', MUNSIT_MODEL);
  const res = await doFetch(MUNSIT_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(5 * 60_000) });
  if (res.status === 401 || res.status === 403) throw new Error('Munsit did not accept the key. Check it in Settings');
  if (!res.ok) throw new Error(`Munsit answered ${res.status}`);
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
  if (!text) throw new Error('Munsit heard no words');
  return text;
}

function avconvert(video: string, out: string): void {
  if (process.platform !== 'darwin') throw new Error('taking the sound out of a video needs a Mac for now');
  execFileSync('avconvert', ['-s', video, '-p', 'PresetAppleM4A', '-o', out, '--replace'], { stdio: 'ignore', timeout: 5 * 60_000 });
}

/** Up to 12 pictures of the screen, spread over the video, each with its time in the corner. */
const FRAMES_SWIFT = `import AVFoundation
import AppKit
let args = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.maximumSize = CGSize(width: 1200, height: 1200)
let dur = CMTimeGetSeconds(asset.duration)
let count = max(1, min(12, Int(dur / 5)))
for i in 0..<count {
  let t = dur * (Double(i) + 0.5) / Double(count)
  guard let img = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) else { continue }
  let rep = NSBitmapImageRep(cgImage: img)
  let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])!
  let name = String(format: "%@-%02d-%dm%02ds.jpg", args[2], i + 1, Int(t) / 60, Int(t) % 60)
  try! data.write(to: URL(fileURLWithPath: name))
  print(name)
}
`;

function swiftFrames(video: string, outPrefix: string): string[] {
  if (process.platform !== 'darwin') return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-frames-'));
  try {
    const script = path.join(dir, 'frames.swift');
    fs.writeFileSync(script, FRAMES_SWIFT);
    const out = execFileSync('swift', [script, video, outPrefix], { encoding: 'utf8', timeout: 3 * 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
