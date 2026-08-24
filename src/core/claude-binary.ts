import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export interface ClaudeBinary {
  path: string;
  source: 'bundled' | 'path';
}

/**
 * Candidate package names for the `claude` executable that `@anthropic-ai/claude-agent-sdk`
 * ships through `optionalDependencies`.
 *
 * The order mirrors the SDK's own resolver (`sdk.mjs`, minified as `N7`) exactly:
 *
 *   linux ? [`…-linux-${arch}-musl`, `…-linux-${arch}`] : [`…-${platform}-${arch}`]
 *
 * The story plan suggested detecting musl via `process.report.getReport().header.glibcVersionRuntime`
 * and trying the non-musl name first. We deliberately do NOT: the platform packages declare only
 * `os`/`cpu` (no `libc`), so a linux host can have BOTH variants installed, and whichever one the
 * SDK picks is the binary the planner actually spawns. Diverging here would let `squad auth login`
 * authenticate through a different executable than `squad new-plan --api` runs on.
 */
export function claudeBinaryPackageSpecs(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const packages =
    platform === 'linux'
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
          `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];

  // The SDK only ever tries `claude.exe` on win32; we try the bare name as a second chance in case
  // a future platform package drops the extension.
  const fileNames = platform === 'win32' ? ['claude.exe', 'claude'] : ['claude'];
  return packages.flatMap((pkg) => fileNames.map((file) => `${pkg}/${file}`));
}

/** Package names only (no `/claude` suffix) — used by the test that keeps the mapping honest. */
export function claudeBinaryPackageNames(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  return claudeBinaryPackageSpecs(platform, arch).map((spec) => spec.slice(0, spec.lastIndexOf('/')));
}

/**
 * Require functions to resolve the platform package from, in order.
 *
 * `createRequire(import.meta.url)` alone is not enough under pnpm: this module lives in the
 * squad-kit package, whose `node_modules/@anthropic-ai/` contains only the symlinked
 * `claude-agent-sdk`, while the platform package sits in a sibling `.pnpm/` store directory.
 * Anchoring a second require at the SDK's own resolved entry point reproduces the lookup the SDK
 * performs from its own `import.meta.url`, which is what actually finds the binary.
 */
function requireAnchors(): NodeJS.Require[] {
  const own = createRequire(import.meta.url);
  const anchors: NodeJS.Require[] = [own];
  try {
    const sdkEntry = own.resolve('@anthropic-ai/claude-agent-sdk');
    anchors.push(createRequire(sdkEntry));
    const realEntry = fs.realpathSync(sdkEntry);
    if (realEntry !== sdkEntry) anchors.push(createRequire(realEntry));
  } catch {
    // SDK not installed (or resolution blocked); PATH is still a valid fallback.
  }
  return anchors;
}

function resolveBundled(): string | undefined {
  const specs = claudeBinaryPackageSpecs();
  for (const req of requireAnchors()) {
    for (const spec of specs) {
      try {
        const resolved = req.resolve(spec);
        if (fs.existsSync(resolved)) return resolved;
      } catch {
        // Next candidate.
      }
    }
  }
  return undefined;
}

function resolveOnPath(): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // `which`/`where` exits non-zero when nothing matches.
  }
  return undefined;
}

let cached: { value: ClaudeBinary | undefined } | undefined;

/**
 * Resolve an executable `claude`. Prefers the binary shipped with the Agent SDK, so a separate
 * Claude Code install is never required. Cached — `auth`, `doctor`, and the console API all call it.
 */
export function resolveClaudeBinary(): ClaudeBinary | undefined {
  if (cached) return cached.value;
  const bundled = resolveBundled();
  if (bundled) {
    cached = { value: { path: bundled, source: 'bundled' } };
    return cached.value;
  }
  const onPath = resolveOnPath();
  cached = { value: onPath ? { path: onPath, source: 'path' } : undefined };
  return cached.value;
}

/** Test seam: drop the module-level cache so a test can exercise a different resolution outcome. */
export function resetClaudeBinaryCache(): void {
  cached = undefined;
}

export const MISSING_CLAUDE_BINARY_MESSAGE =
  'Could not find a `claude` executable. Reinstall squad-kit so the Agent SDK\'s platform binary is present, ' +
  'or install Claude Code and ensure `claude` is on your PATH.';
