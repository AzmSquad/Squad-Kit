/** What the Android module runs programs with. Tests give made-up ones. */

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
  /** What it printed, as bytes, when asked for (a picture). */
  bytes?: Buffer;
}

/** Runs one program and gives what it printed. Tests give a made-up one. */
export type AndroidRun = (file: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; binary?: boolean }) => Promise<Ran>;

/** Starts the emulator on its own, beside squad-kit, writing what it prints to a log file. Gives its process number. */
export type AndroidSpawn = (file: string, args: string[], o: { env: NodeJS.ProcessEnv; log: string }) => number;
