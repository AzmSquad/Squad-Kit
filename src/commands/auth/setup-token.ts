import { spawn } from 'node:child_process';

export interface SetupTokenResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Everything the child wrote to stdout. Empty in `tee: false` mode — stdout went straight to the TTY. */
  output: string;
}

export interface SpawnSetupTokenOptions {
  /**
   * `true` (default): `stdio: ['inherit', 'pipe', 'inherit']`, mirroring the child's stdout to the
   * terminal while buffering it so the printed token can be extracted.
   *
   * `false`: `stdio: 'inherit'` — the child owns the terminal completely and nothing is captured,
   * so the caller must prompt for a paste. Kept because `claude setup-token` may render its
   * authorization prompt differently when stdout is not a TTY.
   */
  tee?: boolean;
}

/**
 * Run `<claude> setup-token`. Split into its own module so tests can assert it was never called
 * (the non-TTY guard must spawn nothing) without stubbing `node:child_process` globally.
 *
 * The absolute resolved path is passed with `shell: false` — on Windows the bundled binary is
 * `claude.exe` under a path that may contain spaces, and a shell would need quoting we would get wrong.
 */
export function spawnSetupToken(
  binaryPath: string,
  opts: SpawnSetupTokenOptions = {},
): Promise<SetupTokenResult> {
  const tee = opts.tee !== false;
  return new Promise<SetupTokenResult>((resolve, reject) => {
    const child = spawn(binaryPath, ['setup-token'], {
      stdio: tee ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
    });

    let output = '';
    if (tee && child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        // The user must be able to read the authorization URL and any prompt. squad-kit reserves
        // stdout for command data (`--print-only` writes the token there), so the mirror goes to stderr.
        process.stderr.write(chunk);
      });
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}
