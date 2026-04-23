const REGISTRY_BASE = 'https://registry.npmjs.org';

export interface RegistryInfo {
  latest: string;
  versions: string[];
}

export async function fetchLatest(packageName: string, timeoutMs = 5000): Promise<RegistryInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(packageName)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`registry ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200));
    const body = (await res.json()) as { 'dist-tags': { latest: string }; versions: Record<string, unknown> };
    return {
      latest: body['dist-tags'].latest,
      versions: Object.keys(body.versions),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isNewer(a: string, b: string): boolean {
  // Simple semver-minor compare without importing a package. Handles x.y.z only.
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
