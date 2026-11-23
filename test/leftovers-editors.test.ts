import { describe, it, expect } from 'vitest';
import { editorProcesses, isEditorProgram, type Proc } from '../src/engine/leftovers.js';

const p = (pid: number, ppid: number, command: string): Proc => ({ pid, ppid, pgid: pid, tty: '', command });

describe("an editor the person opened on a copy is theirs, never a leftover (#36)", () => {
  it('knows the editors and where their extensions run', () => {
    for (const c of [
      '/snap/code/280/usr/share/code/code /home/dev/.vscode/extensions/formulahendry.auto-rename-tag/out/extension.js',
      '/usr/share/code/code --type=utility',
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility',
      '/home/dev/.vscode/extensions/devsense.phptools-vscode-1.50/out/server/devsense.php.ls',
      '/home/dev/.vscode-server/bin/abc/node /home/dev/.vscode-server/extensions/dbaeumer.vscode-eslint/server/out/eslintServer.js',
      '/opt/phpstorm/bin/phpstorm',
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
    ])
      expect(isEditorProgram(c), c).toBe(true);
    for (const c of ['node server.js', 'php artisan serve', 'npx vite --port 5173', '/usr/bin/python3 -m http.server', 'next-server (v15)', 'vitest --code-coverage'])
      expect(isEditorProgram(c), c).toBe(false);
  });

  it("covers what an editor runs, however deep, and nothing else", () => {
    const rows = [
      p(1, 0, '/sbin/init'),
      p(100, 1, '/snap/code/280/usr/share/code/code'),
      p(101, 100, '/snap/code/280/usr/share/code/code --type=extensionHost'),
      p(102, 101, '/usr/bin/php /tmp/intelephense/server.php'),
      p(103, 102, 'docker-langserver --stdio'),
      p(200, 1, 'php artisan serve --port 8000'),
      p(201, 200, 'php -S 127.0.0.1:8000'),
    ];
    const set = editorProcesses(rows);
    expect([...set].sort()).toEqual([100, 101, 102, 103]);
    expect(set.has(200)).toBe(false);
    expect(set.has(201)).toBe(false);
  });
});
