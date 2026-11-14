/**
 * Which Microsoft directory (tenant) an Azure DevOps organization belongs to, found without signing in: Azure DevOps
 * answers a HEAD of the organization's address with no sign-in with 401 and the `X-VSS-ResourceTenant` header (some
 * also with `WWW-Authenticate: Bearer authorization_uri=…/<tenant>`), the way Microsoft's own Git Credential Manager
 * finds it. Its API pages are not asked: an organization with public projects answers those anonymously, with no
 * header. All zeros means the organization is not backed by Microsoft Entra (personal Microsoft accounts): it needs a
 * token.
 */

export type OrgTenant = { kind: 'entra'; tenant: string } | { kind: 'personal' } | { kind: 'not-found' } | { kind: 'no-answer' };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO = '00000000-0000-0000-0000-000000000000';
/** A directory never moves: an answer is kept an hour. Not reaching Azure DevOps is never kept. */
const KEEP_MS = 3_600_000;

const kept = new Map<string, { at: number; t: OrgTenant }>();

export const isTenant = (s: string) => GUID.test(s) && s !== ZERO;

function fromHeaders(h: Headers): OrgTenant | null {
  const ids = (h.get('x-vss-resourcetenant') ?? '').split(',').map((s) => s.trim()).filter((s) => GUID.test(s));
  const tenant = ids.find((s) => s !== ZERO);
  if (tenant) return { kind: 'entra', tenant: tenant.toLowerCase() };
  if (ids.length === 1) return { kind: 'personal' };
  const uri = /authorization_uri=https:\/\/login\.(?:microsoftonline|windows)\.[a-z.]+\/([0-9a-f-]{36})/i.exec(h.get('www-authenticate') ?? '')?.[1];
  return uri && isTenant(uri) ? { kind: 'entra', tenant: uri.toLowerCase() } : null;
}

/** The organization's directory, asked once an hour at most. */
export async function orgTenant(org: string, http: typeof fetch = fetch): Promise<OrgTenant> {
  const key = org.toLowerCase();
  const was = kept.get(key);
  if (was && Date.now() - was.at < KEEP_MS) return was.t;
  let t: OrgTenant;
  try {
    const res = await http(`https://dev.azure.com/${encodeURIComponent(org)}`, {
      method: 'HEAD',
      redirect: 'manual',
      // A 401 instead of the sign-in page's redirect, as for every other call squad-kit makes.
      headers: { 'X-TFS-FedAuthRedirect': 'Suppress' },
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => undefined);
    t = fromHeaders(res.headers) ?? (res.status === 404 ? { kind: 'not-found' } : { kind: 'no-answer' });
  } catch {
    t = { kind: 'no-answer' };
  }
  if (t.kind !== 'no-answer') kept.set(key, { at: Date.now(), t });
  return t;
}

/** A test asks again. */
export function forgetTenants(): void {
  kept.clear();
}
