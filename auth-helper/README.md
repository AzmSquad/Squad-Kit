# squad-kit sign-in helper

A small Cloudflare Worker at `https://auth.squad-kit.com` for **Sign in with Atlassian** in squad-kit. It is not part
of the npm package.

## Why it exists

Atlassian's sign-in for apps (OAuth 2.0, 3LO) needs the app's client secret every time a sign-in code is exchanged
and every time a sign-in is refreshed. A secret cannot ship inside an npm package that anyone can download. So this
helper keeps the secret, adds it to those two calls, and passes Atlassian's answer straight back to squad-kit on your
computer.

## What it stores

No codes and no tokens. It has no database and no storage, it writes no logs (observability and log push are off),
and it never prints a code, a token or a request body. Each request is answered and forgotten. The one thing counted is
how many requests came from each address in the last minute (Cloudflare's rate limit, below), to stop abuse.

## Routes

| Route | What it does |
| --- | --- |
| `GET /atlassian/callback?code&state` | Atlassian sends you here after Accept or Cancel. `state` is `<port>.<nonce>`, made by squad-kit. The answer goes on (302) to squad-kit's one-shot door on your own computer, `http://127.0.0.1:<port>/atlassian`, and never to another host. A state squad-kit did not make gets a plain page. |
| `POST /atlassian/token` | JSON `{ "code": "…" }`. Exchanges the code with Atlassian (`grant_type: authorization_code`, the fixed `redirect_uri` `https://auth.squad-kit.com/atlassian/callback`, the client id and secret). Atlassian's JSON and status come back as they are. |
| `POST /atlassian/refresh` | JSON `{ "refresh_token": "…" }`. Asks Atlassian for a new pair (`grant_type: refresh_token`). Atlassian rotates refresh tokens: the old one stops working. |
| Anything else | 404. |

JSON only, at most 8 KB, no CORS (squad-kit calls it from Node, so a request from a web page is refused), and
`Cache-Control: no-store` on every answer. The code exchange and the refresh take about 30 requests a minute from one
address (Cloudflare's rate limiting binding `TOKEN_LIMIT` in `wrangler.jsonc`, counted per Cloudflare location), then
answer a plain 429. squad-kit refreshes about once an hour, so a person never meets it.

If Cloudflare refuses the `ratelimits` binding on the account's plan, take that block out of `wrangler.jsonc` (the
helper then runs without it) and add a rule in the dashboard instead: the `squad-kit.com` zone, Security, WAF, Rate
limiting rules, Create rule. When: URI Path is in `/atlassian/token` `/atlassian/refresh`. Same characteristics: IP.
Requests: 30 per 1 minute (on Free, the period may be fixed at 10 seconds: then 10 per 10 seconds). Action: Block, for
the shortest duration.

## Set up (the owner, once)

1. On developer.atlassian.com, make an OAuth 2.0 (3LO) app for squad-kit. Callback URL:
   `https://auth.squad-kit.com/atlassian/callback`. Add a privacy policy URL (squad-kit.com/privacy).
2. Permissions, Jira API. Classic scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`. Granular scopes (Jira
   Software's board and sprint calls take only these): `read:board-scope:jira-software`, `read:sprint:jira-software`,
   `read:project:jira`, `read:issue-details:jira`. squad-kit also asks for `offline_access`, so the sign-in lasts.
3. Put the app's Client ID in `wrangler.jsonc` (`ATLASSIAN_CLIENT_ID`) and in squad-kit
   (`src/modules/jira/atlassian-app.ts`).
4. Put the secret in Cloudflare, never in a file:

```bash
cd auth-helper
npx wrangler@4.149.0 secret put ATLASSIAN_CLIENT_SECRET
npx wrangler@4.149.0 deploy
```

The first deploy makes the `auth.squad-kit.com` record and certificate in the `squad-kit.com` zone.

## Tests

`test/auth-helper.test.ts` in squad-kit's suite calls the Worker's `fetch` with a made-up Atlassian.
