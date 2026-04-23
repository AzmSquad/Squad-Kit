import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function writeFileSafe(file: string, content: string, overwrite = false): boolean {
  if (!overwrite && fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

export function copyTree(srcDir: string, destDir: string, overwrite = false): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, overwrite);
    } else if (entry.isFile()) {
      if (!overwrite && fs.existsSync(dest)) continue;
      fs.copyFileSync(src, dest);
    }
  }
}

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/utils → package root when running from source (tsx/vitest)
  // dist      → package root when running from bundle
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'templates'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate squad-kit package root from ${here}`);
}

export function templatesDir(): string {
  return path.join(packageRoot(), 'templates');
}

/**
 * Read a prompt file from the installed squad-kit package's `templates/prompts/` directory.
 * This is the ONLY supported way to read prompts. Users do not have the ability to override
 * them; `.squad/prompts/` is legacy and ignored at runtime.
 *
 * @throws if the file is missing (indicates a broken package install).
 */
export function readBundledPrompt(name: 'generate-plan.md' | 'intake.md' | 'story-skeleton.md'): string {
  const file = path.join(templatesDir(), 'prompts', name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Bundled prompt "${name}" not found at ${file}. ` +
        `This indicates a broken squad-kit install — reinstall with: pnpm add -g squad-kit`,
    );
  }
  return fs.readFileSync(file, 'utf8');
}
