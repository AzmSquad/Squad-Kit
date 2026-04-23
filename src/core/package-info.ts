import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../utils/fs.js';

export interface InstalledPackage {
  name: string;
  version: string;
  root: string;
  /** Git repository URL from package.json (for changelog links). */
  repositoryUrl?: string;
  /** True if the binary is running from a linked local checkout (pnpm link, npm link). */
  isDevInstall: boolean;
}

/**
 * Build a GitHub/GitLab-style blob URL for CHANGELOG.md at a tagged release.
 */
export function changelogBlobUrl(repositoryUrl: string | undefined, version: string): string {
  let base = repositoryUrl;
  if (!base) base = 'https://github.com/AzmSquad/squad-kit';
  if (base.startsWith('git+')) base = base.slice(4);
  if (base.endsWith('.git')) base = base.slice(0, -4);
  base = base.replace(/\/$/, '');
  return `${base}/blob/v${version}/CHANGELOG.md`;
}

export function readInstalledPackage(): InstalledPackage {
  const root = packageRoot();
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
    name: string;
    version: string;
    repository?: { url?: string };
  };

  // Dev-install detection: the package root contains a `src/` directory (source lives alongside dist).
  // Registry installs only ship dist/ + templates/ (per the files field in package.json).
  const isDevInstall = fs.existsSync(path.join(root, 'src'));

  return {
    name: pkg.name,
    version: pkg.version,
    root,
    repositoryUrl: pkg.repository?.url,
    isDevInstall,
  };
}
