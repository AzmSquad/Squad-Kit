import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { azFolder } from '../../src/modules/azure/az.js';
import { azureConnection } from '../../src/modules/azure/connection.js';
import { forgetMicrosoftFlow } from '../../src/modules/azure/device-sign-in.js';

/**
 * Microsoft's sign-in for a test (ADR-011): a made-up az first on the PATH, which prints what the real az 2.88 prints and
 * keeps its sign-in in the folder squad-kit gives it, and Azure DevOps answered by the test's own routes. Nothing
 * reaches Microsoft, and the person's own az is never run.
 */

export const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
export const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';
export const ZEROS = '00000000-0000-0000-0000-000000000000';
/** What the made-up az hands out as the Azure DevOps token. */
export const MS_TOKEN = 'ms-made-up-token-5c1d';

/** The real az prints its code like this, on its error side, then waits for the person (here: a file named approve). */
export const AZ = `#!/bin/sh
D="$(dirname "$0")"
echo "$* | dir=$AZURE_CONFIG_DIR | telemetry=$AZURE_CORE_COLLECT_TELEMETRY" >> "$D/calls.log"
P="$AZURE_CONFIG_DIR/azureProfile.json"
case "$1 $2" in
  "version --output") echo '{"azure-cli": "2.88.0", "azure-cli-core": "2.88.0", "extensions": {}}'; exit 0;;
  "account get-access-token")
    if [ ! -f "$P" ]; then echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; fi
    if [ -f "$D/refuse" ]; then echo "ERROR: AADSTS50020: User account from identity provider does not exist in tenant." >&2; exit 1; fi
    if [ -f "$D/offline" ]; then echo "ERROR: HTTPSConnectionPool(host='login.microsoftonline.com', port=443): Max retries exceeded (Failed to establish a new connection)" >&2; exit 1; fi
    # The token is read first, then the wait: an answer that is old by the time it arrives, as a real one can be.
    T="$(cat "$D/token" 2>/dev/null || echo ${MS_TOKEN})"
    if [ -f "$D/slow" ]; then sleep 1; fi
    E=$(( $(date +%s) + $(cat "$D/life" 2>/dev/null || echo 3600) ))
    printf '{\\n  "accessToken": "%s",\\n  "expiresOn": "2026-11-14 01:30:00.000000",\\n  "expires_on": %s,\\n  "tokenType": "Bearer"\\n}\\n' "$T" "$E"
    exit 0;;
  "account clear") rm -f "$P"; exit 0;;
  "login --use-device-code")
    TENANT=""; prev=""
    for a in "$@"; do if [ "$prev" = "--tenant" ]; then TENANT="$a"; fi; prev="$a"; done
    if [ -f "$D/silent" ]; then sleep 10; exit 1; fi
    echo "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code GZ3SDVTBE to authenticate." >&2
    sh -c 'echo $$ > "$1/inner.pid"; i=0; while [ ! -f "$1/approve" ]; do sleep 0.05; i=$((i+1)); if [ $i -gt 600 ]; then exit 1; fi; done' inner "$D"
    if [ $? -ne 0 ]; then echo "ERROR: The code expired." >&2; exit 1; fi
    if [ -f "$D/decline" ]; then echo "ERROR: AADSTS70016: The person declined the sign-in." >&2; exit 1; fi
    printf '\\357\\273\\277{"installationId": "x", "subscriptions": [{"id": "%s", "name": "N/A(tenant level account)", "state": "Enabled", "user": {"name": "sara@contoso.com", "type": "user"}, "isDefault": true, "tenantId": "%s", "environmentName": "AzureCloud"}]}' "\${TENANT:-$TENANT_HOME}" "\${TENANT:-$TENANT_HOME}" > "$P"
    exit 0;;
esac
exit 0
`.replaceAll('$TENANT_HOME', OTHER_TENANT);

export interface FakeAz {
  bin: string;
  /** Every az run: its words, the settings folder it was given, and whether it reports usage. */
  calls(): string[];
  /** Puts a file the made-up az reads: approve, refuse, offline, slow, silent, decline, life, token. */
  touch(name: string, text?: string): void;
  done(): void;
}

/** squad-kit as already signed in with Microsoft: its own az profile, in squad-kit's own folder. */
export function signedIn(tenant = TENANT, user = 'sara@contoso.com'): void {
  fs.mkdirSync(azFolder(), { recursive: true });
  const profile = { installationId: 'x', subscriptions: [{ id: tenant, name: 'N/A(tenant level account)', user: { name: user, type: 'user' }, isDefault: true, tenantId: tenant }] };
  fs.writeFileSync(path.join(azFolder(), 'azureProfile.json'), `﻿${JSON.stringify(profile)}`);
}

/** Every bit of Microsoft sign-in state squad-kit keeps in memory, forgotten. */
export function forgetAzure(): void {
  azureConnection.forget?.();
  forgetMicrosoftFlow();
}

export function fakeAz(): FakeAz {
  const before = process.env.PATH;
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-fake-az-')));
  fs.writeFileSync(path.join(bin, 'az'), AZ, { mode: 0o755 });
  // A file written without the run bit runs through sh on Linux: set it plainly.
  fs.chmodSync(path.join(bin, 'az'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${before ?? ''}`;
  forgetAzure();
  const log = path.join(bin, 'calls.log');
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    touch: (name, text = '') => fs.writeFileSync(path.join(bin, name), text),
    done: () => {
      process.env.PATH = before;
      forgetAzure();
      fs.rmSync(azFolder(), { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

export interface DevOpsCall {
  url: string;
  auth?: string;
}

/**
 * Azure DevOps for a test: an organization answers a call with no sign-in with its directory in X-VSS-ResourceTenant
 * (as the real one does for a HEAD of its address), its connectionData with the person's name for the made-up Microsoft token or any token, and
 * anything else with `answer` or a 404. `access: false`: the Microsoft account is not in the organization.
 */
export function fakeDevOps(o: { orgs?: Record<string, string>; access?: boolean; tokens?: string[]; offline?: boolean; answer?: (c: DevOpsCall) => unknown } = {}) {
  const orgs = o.orgs ?? { contoso: TENANT };
  const calls: DevOpsCall[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? headers.Authorization;
    if (u.host !== 'dev.azure.com') throw new Error(`Not a call to the fake Azure DevOps: ${url}`);
    const c: DevOpsCall = { url, ...(auth ? { auth } : {}) };
    calls.push(c);
    if (o.offline) throw new TypeError('fetch failed');
    const tenant = orgs[decodeURIComponent(u.pathname.split('/')[1] ?? '')];
    if (!tenant) return new Response('', { status: 404 });
    // The organization's own address, with no sign-in: 401 and its directory, as the real one answers a HEAD.
    if (!auth) return new Response(null, { status: 401, headers: { 'x-vss-resourcetenant': tenant, 'www-authenticate': `Bearer authorization_uri=https://login.microsoftonline.com/${tenant}` } });
    const known = auth.startsWith('Bearer ') ? (o.tokens ?? [MS_TOKEN]).includes(auth.slice(7)) && o.access !== false : auth.startsWith('Basic ');
    if (!known) return new Response('', { status: 401 });
    if (u.pathname.endsWith('/_apis/connectionData')) return json({ authenticatedUser: { providerDisplayName: auth.startsWith('Basic ') ? 'Sara (token)' : 'Sara Ahmed' } });
    const a = o.answer?.(c);
    return a === undefined ? json({ message: 'Not found' }, 404) : json(a);
  });
  return { calls, done: () => vi.unstubAllGlobals() };
}
