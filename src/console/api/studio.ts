import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { readStudio, type DesignSystem, type Sketch } from '../../board/studio.js';
import { act } from './act.js';

/**
 * What the project's Studio holds, as this computer's squad-kit reads it from `.squad/studio/`: every design system
 * and sketch with its change stamp, versions, screens, variants and chosen variant, and the one default design system.
 * Read-only, and reading makes no folder, so opening the Studio writes nothing (AB-127.1). The HTML stays in the files;
 * this lists what is there.
 */

function designSystemRow(ds: DesignSystem, defaultId: string | null) {
  return {
    id: ds.id,
    name: ds.name,
    /** The project's one default, worked out on read (AB-158.1): only one row is ever true. */
    isDefault: ds.id === defaultId,
    /** What its own system.yaml says; two can be marked after a merge. */
    markedDefault: ds.markedDefault,
    version: ds.version,
    madeAt: ds.madeAt,
    stamp: ds.stamp,
    versions: ds.versions.map((v) => ({ version: v.version, tokens: v.tokens, components: Object.keys(v.components) })),
  };
}

function sketchRow(s: Sketch) {
  return {
    id: s.id,
    name: s.name,
    designSystem: s.designSystem,
    frames: s.frames,
    stamp: s.stamp,
    screens: s.screens.map((sc) => ({
      id: sc.id,
      name: sc.name,
      order: sc.order,
      status: sc.status,
      chosen: sc.chosen,
      variants: sc.variants.map((v) => ({ version: v.version, frames: Object.keys(v.frames), madeAt: v.madeAt, ...(v.madeBy ? { madeBy: v.madeBy } : {}), ...(v.note ? { note: v.note } : {}) })),
    })),
  };
}

export function mountStudioApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  app.get('/api/v1/studio', (c) =>
    act(c, () => {
      const studio = readStudio(bp);
      return {
        designSystems: studio.designSystems.map((ds) => designSystemRow(ds, studio.defaultDesignSystem)),
        defaultDesignSystem: studio.defaultDesignSystem,
        sketches: studio.sketches.map(sketchRow),
        ...(studio.broken.length ? { broken: studio.broken } : {}),
      };
    }),
  );
}
