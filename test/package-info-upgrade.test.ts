import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ gone: false }));
vi.mock('../src/utils/fs.js', async (orig) => {
  const real = await orig<typeof import('../src/utils/fs.js')>();
  return {
    ...real,
    packageRoot: (...a: Parameters<typeof real.packageRoot>) => {
      if (h.gone) throw new Error('Could not locate squad-kit package root from /usr/lib/node_modules/squad-kit/dist');
      return real.packageRoot(...a);
    },
  };
});

const { readInstalledPackage } = await import('../src/core/package-info.js');

describe("squad-kit's own package while an update replaces its files (#39)", () => {
  it('answers with the version that runs, not an error', () => {
    const before = readInstalledPackage();
    h.gone = true;
    expect(readInstalledPackage()).toEqual(before);
    h.gone = false;
  });
});
