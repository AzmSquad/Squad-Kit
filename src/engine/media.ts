import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BoardPaths } from '../board/store.js';
import { speechFor, speechModule } from '../modules/registry.js';
import { ModuleError } from '../modules/errors.js';
import { writeLog } from '../core/app-log.js';

const run = promisify(execFile);

/**
 * Voice and video notes. Agents read text and pictures but cannot listen, so squad-kit writes each note out itself
 * before an agent sees it: the words through the speech to text module, and for a video, pictures of the screen. The
 * results sit next to the note as ordinary attachments. Without a speech key the notes stay attached, unheard.
 */

export const AUDIO_FILE = /\.(ogg|opus|oga|m4a|mp3|wav|aac|amr|flac|weba)$/i;
export const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;
export const MAX_NOTE_BYTES = 100 * 1024 * 1024;

export function isMediaNote(file: string): boolean {
  return AUDIO_FILE.test(file) || VIDEO_FILE.test(file);
}

/** A video's sound and pictures can only be taken out on a Mac for now: Settings says so per computer. */
export function videoNotesWork(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** Why one note could not be written out, in words a person can read. */
class NoteTrouble extends Error {}

/** The line for a note that failed: plain words only, and the exact error for engineers in the app log. */
function noteTroubleWords(err: unknown): string {
  if (err instanceof NoteTrouble) return err.message;
  if (err instanceof ModuleError && err.kind !== 'other') return err.message;
  return 'something went wrong with it, so nobody can hear it for now';
}

export function transcriptOf(file: string): string {
  return `${file}.transcript.txt`;
}

export interface MediaResult {
  /** New files to hand the agents: transcripts and pictures of the screen. */
  added: string[];
  /** One line per note for the ticket's activity. */
  notes: string[];
  /** Notes were attached but no speech key is saved, so nobody can hear them. */
  missingKey: boolean;
}

export interface MediaOptions {
  key?: string;
  fetch?: typeof fetch;
  /** Takes the sound out of a video. Defaults to macOS avconvert. */
  extractAudio?: (video: string, out: string) => void | Promise<void>;
  /** Saves pictures of a video's screen and returns their paths. Defaults to AVFoundation through swift. */
  extractFrames?: (video: string, outPrefix: string) => string[] | Promise<string[]>;
}

/** Writes out every voice and video note in `files` that has no transcript yet. Never throws: a note that fails is reported and skipped. */
export async function prepareMedia(bp: BoardPaths, files: string[], opts: MediaOptions = {}): Promise<MediaResult> {
  const notes = files.filter((f) => isMediaNote(f) && !fs.existsSync(transcriptOf(f)));
  const result: MediaResult = { added: [], notes: [], missingKey: false };
  if (!notes.length) return result;
  const speech = speechFor(bp, { ...(opts.key ? { key: opts.key } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  if (!speech) {
    result.missingKey = true;
    result.notes.push(`${notes.length === 1 ? '1 voice or video note is' : `${notes.length} voice or video notes are`} attached, but nobody can listen to ${notes.length === 1 ? 'it' : 'them'}. Add a ${speechModule().label} key in Settings`);
    return result;
  }
  for (const note of notes) {
    const name = path.basename(note);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-media-'));
    try {
      if (fs.statSync(note).size > MAX_NOTE_BYTES) throw new NoteTrouble('it is larger than 100 MB');
      let audio = note;
      if (VIDEO_FILE.test(note)) {
        audio = path.join(tmp, 'sound.m4a');
        await (opts.extractAudio ?? avconvert)(note, audio);
        try {
          const frames = await (opts.extractFrames ?? swiftFrames)(note, `${note}.screen`);
          result.added.push(...frames);
        } catch {
          // Pictures of the screen are a bonus; the words matter more.
        }
      }
      const text = await speech.transcribe(audio);
      fs.writeFileSync(transcriptOf(note), `Transcript of ${name} (written out by ${speech.label} speech to text, may have small mistakes):\n\n${text}\n`);
      result.added.push(transcriptOf(note));
      result.notes.push(`Wrote out ${name}`);
    } catch (err) {
      writeLog({ level: 'warn', text: `Could not write out ${name}: ${(err as Error).message}` });
      result.notes.push(`Could not write out ${name}: ${noteTroubleWords(err)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return result;
}

/** Takes minutes on a long video, so it runs beside the app, and every page keeps answering. */
async function avconvert(video: string, out: string): Promise<void> {
  if (!videoNotesWork()) throw new NoteTrouble('taking the sound out of a video needs a Mac for now');
  await run('avconvert', ['-s', video, '-p', 'PresetAppleM4A', '-o', out, '--replace'], { timeout: 5 * 60_000 });
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

async function swiftFrames(video: string, outPrefix: string): Promise<string[]> {
  if (!videoNotesWork()) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-frames-'));
  try {
    const script = path.join(dir, 'frames.swift');
    fs.writeFileSync(script, FRAMES_SWIFT);
    const { stdout: out } = await run('swift', [script, video, outPrefix], { encoding: 'utf8', timeout: 3 * 60_000 });
    return out.split('\n').map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
