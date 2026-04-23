import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fsUtils from '../src/utils/fs.js';
import { changelogBlobUrl, readInstalledPackage } from '../src/core/package-info.js';

let tmp: string;
let packageRootSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pkginfo-'));
  fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({
      name: 'squad-kit',
      version: '9.9.9-test',
      repository: { type: 'git', url: 'https://github.com/owner/repo.git' },
    }),
    'utf8',
  );
  packageRootSpy = vi.spyOn(fsUtils, 'packageRoot').mockReturnValue(tmp);
});

afterEach(() => {
  packageRootSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readInstalledPackage', () => {
  it('reads name and version from package.json', () => {
    const p = readInstalledPackage();
    expect(p.name).toBe('squad-kit');
    expect(p.version).toBe('9.9.9-test');
    expect(p.root).toBe(tmp);
    expect(p.isDevInstall).toBe(false);
    expect(p.repositoryUrl).toBe('https://github.com/owner/repo.git');
  });

  it('sets isDevInstall when src/ exists', () => {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const p = readInstalledPackage();
    expect(p.isDevInstall).toBe(true);
  });
});

describe('changelogBlobUrl', () => {
  it('normalises git+ and .git suffix', () => {
    expect(changelogBlobUrl('git+https://github.com/foo/bar.git', '1.0.0')).toBe(
      'https://github.com/foo/bar/blob/v1.0.0/CHANGELOG.md',
    );
  });

  it('uses default when repository is missing', () => {
    expect(changelogBlobUrl(undefined, '0.2.0')).toContain('AzmSquad/squad-kit');
    expect(changelogBlobUrl(undefined, '0.2.0')).toContain('v0.2.0');
  });
});
