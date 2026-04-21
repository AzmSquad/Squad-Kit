import { spawn } from 'node:child_process';

export async function copyToClipboard(text: string): Promise<boolean> {
  const cmd = clipboardCommand();
  if (!cmd) return false;
  return new Promise((resolve) => {
    const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.write(text);
    child.stdin.end();
  });
}

function clipboardCommand(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') return { command: 'pbcopy', args: [] };
  if (process.platform === 'win32') return { command: 'clip', args: [] };
  if (process.env.WAYLAND_DISPLAY) return { command: 'wl-copy', args: [] };
  if (process.env.DISPLAY) return { command: 'xclip', args: ['-selection', 'clipboard'] };
  return null;
}
