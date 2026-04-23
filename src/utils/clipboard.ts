import { spawn, spawnSync } from 'node:child_process';

export interface ClipboardResult {
  ok: boolean;
  /** Which clipboard tool was used (pbcopy, clip, wl-copy, xclip, xsel, termux-clipboard-set). */
  tool?: string;
  /** Human-readable reason when ok === false. */
  reason?: string;
}

interface ClipboardCommand {
  command: string;
  args: string[];
  /** Called before use — returns a reason string if the tool is unavailable. */
  unavailableReason?: () => string | undefined;
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const candidates = clipboardCandidates();
  if (candidates.length === 0) {
    return { ok: false, reason: noCandidateReason() };
  }

  let lastReason: string | undefined;
  for (const cmd of candidates) {
    const reason = cmd.unavailableReason?.();
    if (reason) {
      lastReason = reason;
      continue;
    }
    const res = await tryCopy(cmd, text);
    if (res.ok) return res;
    lastReason = res.reason;
  }
  return { ok: false, reason: lastReason ?? 'no working clipboard tool found' };
}

function tryCopy(cmd: ClipboardCommand, text: string): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, reason: `${cmd.command} failed to spawn: ${(err as Error).message}` });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `${cmd.command} spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, tool: cmd.command });
      } else {
        resolve({
          ok: false,
          reason: `${cmd.command} exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`,
        });
      }
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}

function clipboardCandidates(): ClipboardCommand[] {
  if (process.platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }
  if (process.platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }
  const out: ClipboardCommand[] = [];
  if (process.env.WAYLAND_DISPLAY) {
    out.push({ command: 'wl-copy', args: [], unavailableReason: hasBinary('wl-copy') });
  }
  if (process.env.DISPLAY) {
    out.push({ command: 'xclip', args: ['-selection', 'clipboard'], unavailableReason: hasBinary('xclip') });
    out.push({ command: 'xsel', args: ['--clipboard', '--input'], unavailableReason: hasBinary('xsel') });
  }
  if (process.env.TERMUX_VERSION) {
    out.push({ command: 'termux-clipboard-set', args: [], unavailableReason: hasBinary('termux-clipboard-set') });
  }
  return out;
}

function hasBinary(bin: string): () => string | undefined {
  return () => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(which, [bin], { stdio: 'ignore' });
    if (res.status === 0) return undefined;
    return `${bin} not found on PATH`;
  };
}

function noCandidateReason(): string {
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.TERMUX_VERSION) {
      return 'no display server detected (headless / SSH) — install xclip or xsel, or use the saved file';
    }
    return 'no clipboard tool detected — install xclip, xsel, or wl-copy';
  }
  return `no clipboard tool detected on ${process.platform}`;
}
