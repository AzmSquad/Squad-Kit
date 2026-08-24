# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.1] — 2026-08-24

### Bug fixes

- `squad auth login` ended a **successful** browser login with
  `could not verify the login (unknown)` and a warning that the credential "may
  be invalid or expired". The token was fine. `accountInfo()` resolves from the
  Agent SDK's `initialize` response, and for `CLAUDE_CODE_OAUTH_TOKEN` auth that
  response carries `{tokenSource, apiProvider}` and **never** an account — for a
  valid token exactly as much as for a bogus one. 0.12.0 treated a missing
  account as a failed credential, which flagged every healthy login through the
  primary documented flow.

  The probe now separates three outcomes instead of two: an account came back
  (verified, shown); a credential *source* came back without an account
  (reported as resolved, with the honest caveat that token validity can only be
  confirmed by an actual planning run); or nothing came back at all (still
  treated as unverified). `squad auth login`'s summary and `squad doctor`'s
  planner credential row both reflect which applies, and neither claims a
  verification the SDK cannot perform.

  Workspaces that authenticate through the OS credential store are unaffected —
  those do report an account and are still verified as before.

## [0.12.0] — 2026-08-24

### What's new

- **Plan on your Claude subscription.** The Anthropic planner can authenticate
  with the Claude login you already have (Pro, Max, or Team/Enterprise) instead
  of an API key. `squad new-plan --api` and the console Generate page both run
  on it. No per-token API bill. OpenAI and Google are unchanged and remain
  API-key only.
- **`squad auth login | status | logout`.** `login` runs the Anthropic browser
  authorization flow and stores the resulting token in `.squad/secrets.yaml`;
  `--token <value>` consumes a `claude setup-token` value on a headless machine,
  and `--print-only` runs the flow, prints the token, and stores nothing.
  `status` reports the resolved mode, the credential behind it, and the
  signed-in account (`--json` for a stable scripting shape, `--offline` to skip
  the live check). `logout` removes only the token squad-kit stored.
- **`planner.auth.anthropic`** in `.squad/config.yaml` — `subscription`,
  `api-key`, or `auto`. The merged default is **`auto`**: prefer a detected
  Claude login, fall back to a resolvable API key, otherwise fail naming both
  recovery paths. `squad init` offers the subscription as the first and default
  choice for new workspaces and writes it explicitly.
- **`planner.anthropicOauthToken`** is a new secrets-only key. `.squad/config.yaml`
  rejects it by name at load time.
- **Subscription runs withhold the API key.** In subscription mode
  `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed (case-insensitively)
  from the planner subprocess environment. Both outrank the login credential
  inside Claude Code, so an inherited one would silently bill API credits. The
  parent shell is untouched.
- **No new runtime dependency.** `squad auth login` shells out to the `claude`
  binary that `@anthropic-ai/claude-agent-sdk` already ships through
  `optionalDependencies`. A separate Claude Code install is never required.
- **Auth-aware `squad doctor`.** New `planner auth mode` (resolved mode, why,
  and the credential — naming any API key it is ignoring) and
  `planner auth vs. runtime` (subscription auth requires the Agent SDK runtime)
  checks. `planner model resolves at provider` and `planner tier vs. model` now
  **skip** on subscription auth: there is no API key to list models with and no
  API rate tier to warn about.
- **Console auth surface.** An Authentication control on Config (with a
  hard-conflict callout that disables Save), a Claude Account card on Secrets
  with a live "Check again" probe and a masked stored token, an auth badge and
  branched billing copy on Generate, a dedicated recovery callout for
  `auth_unavailable` failures, and an Auth column on the runs index. The console
  guides the login and never performs it — it cannot complete an OAuth callback
  on your behalf.
- **Run records carry `authMode`**, and the planner stream gained one additive
  `auth_info` event. Older clients ignore unknown event kinds.
- **Cost copy branches on auth mode.** `printPlannerApiCostNotice()` and the
  limit explanations no longer describe per-token billing on a subscription run.

### Bug fixes

- Planner model-list probe (`src/core/probes.ts`): a network-level `fetch`
  rejection (offline, DNS failure, proxy refusal) or a non-JSON response body
  threw out of `fetchProviderModelIds` instead of returning a failure result, so
  `squad doctor`'s `planner model resolves at provider` check surfaced an
  unexpected error rather than a clean diagnosis. Both are now caught and
  reported as `status: 0` with the message, and long error bodies are truncated.
  Shipped to GitHub after v0.11.0 (`d2d67a1`) and missed the 0.11.0 changelog.

### Upgrade notes

Zero-config. A `config.yaml` with no `planner.auth` block merges to `auto` and
keeps loading; every existing `planner.*` key, including `maxOutputTokens`, is
unaffected. An untouched 0.11.0 API-key workspace resolves to `api-key` and
behaves identically — **provided the machine has no Claude login**.

Under `auto`, a detected Claude login **outranks** a stored API key. So on a
machine that has both, an upgraded workspace switches to subscription billing.
Nothing errors, and the change is announced rather than silent: `squad doctor`'s
`planner auth mode` row reads `subscription (auto — Claude login detected) → …
· ignoring the API key from .squad/secrets.yaml`. Set
`planner.auth.anthropic: api-key` to pin the previous behaviour.

`squad doctor --fix` deliberately does **not** pin an implicit `auto` to
`api-key`. `auto` exists so that a Claude login takes over once one appears;
pinning would silently prevent that forever.

### Notes / limitations

- **Usage draws on your Claude plan's limits.** Per Anthropic's
  [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
  Agent SDK, `claude -p`, and third-party usage consumes the subscription's
  usage limits, and the separately announced monthly SDK credit is not currently
  available. The claim this release makes is **"no per-token API bill"** — not
  free, and not unlimited. Opus planning against a **Pro** plan consumes a usage
  window noticeably faster than against **Max**. Hitting the ceiling means
  waiting for the reset window or switching to an API key.
- **Enterprise managed-settings `apiKeyHelper` still wins.** squad-kit runs the
  Agent SDK with `settingSources: []`, so user, project, and local settings are
  not read and an ordinary user-level `apiKeyHelper` cannot hijack a
  subscription run. **Policy settings are always merged regardless**, so a
  managed-settings `apiKeyHelper` deployed by MDM is still honoured and still
  outranks the login credential — on a managed device, `auth: subscription` may
  resolve through the organization's helper. This was established by reading the
  credential resolver in the bundled `claude` binary, **not** on a live managed
  device. `squad auth status` reports the `apiKeySource` the SDK actually
  resolved.
- **`auth: subscription` requires the Agent SDK runtime.** `@ai-sdk/anthropic`
  authenticates with `x-api-key`, and an OAuth credential is not an API key.
  `auth: subscription` with `planner.runtime.anthropic: vercel`, or with a
  non-Anthropic provider, is a hard failure before any network call — never a
  silent downgrade to API billing.
- **Account details are never persisted.** Email, organization, and plan are
  fetched live for display in `squad auth status`, `squad doctor`, and the
  console. `.squad/runs/` records the resolved **mode** and `apiKeySource` only —
  no token, key, email, or organization. Asserted by a test.
- **A successful SDK handshake does not prove the credential works.**
  `accountInfo()` resolves from the subprocess's `initialize` response, which
  succeeds whether or not the credential is valid. Subscription auth that
  reports no account **and** no `apiKeySource` is therefore treated as
  unverified rather than signed in.
- `docs/auth.md` is not shipped inside the npm tarball. It is served at
  <https://squad-kit.com/docs/auth> and lives in the repo under `docs/`.

## [0.11.0] — 2026-05-04

### What's new

- API `new-plan` can append planner events to `.squad/runs/<id>.events.jsonl`
  (thinking text redacted on disk; retention rotates old files).
- Agent SDK runs emit richer events (tool lifecycle, thinking deltas, caps,
  runtime metadata) for the CLI and console.
- API-mode `new-plan` prints stage pipeline, budget meters, and thinking
  activity; the plan summary cites the events file path.
- `squad console` HTTP API lists persisted runs and serves stored event streams.
- Console UI adds a runs index, run report page, and a reworked Generate view
  with live panels and navigation.

### Bug fixes

- `squad doctor` skips live external probes when `CI` is set and surfaces
  planner probe errors cleanly.
- Vitest timeouts increased for slow config loads and console API tests.

## [0.10.0] — 2026-05-04

### What's new

- Anthropic planning defaults to the Claude Agent SDK so Opus 4.7 can use
  adaptive thinking and effort; OpenAI and Google stay on the Vercel AI SDK.
- Planner YAML and CLI cover runtime choice, thinking mode, effort, and
  per-phase effort (`--anthropic-runtime`, `--effort`, `--scout-effort`,
  `--no-thinking`).
- The planner summary shows which runtime ran; run JSON may record runtime and
  a provider-options snapshot for dashboards and tooling.
- `squad doctor` checks runtime wiring, model vs runtime fit, and the Agent SDK
  binary.
- Published CLI no longer bundles `cli.js.map`; set `SQUAD_TSUP_SOURCEMAP=1`
  when running `tsup` locally if you need a source map.
- On the Agent SDK path, cache token counts are not surfaced in telemetry
  (caching still applies); live usage stays aggregate-only until the run ends;
  cancel may not stop the upstream HTTP request immediately.

## [0.9.1] — 2026-05-04

### Bug fixes

- Anthropic scout and draft attach extended thinking so Opus 4.7+ avoids
  failed calls when the SDK would send incompatible temperature overrides.

## [0.9.0] — 2026-05-04

### What's new

- Scout precedes the draft planner in API `new-plan` for a cheaper first pass.
- Validation verifies citations offline and suggests typo fixes for paths.
- New planner tools: `grep`, `list_dir`, and `read_file` with offset/limit.
- Scout sees a bullet list of `.squad/plans/` markdown (caps at ~30 files).
- Anthropic/OpenAI/Google run through Vercel AI SDK (`ai`, `@ai-sdk/*`).
- Tool outputs keep `toolName`/`isError` metadata across turns where supported.
- Scout snippets use separate user-role cache blocks for stabler prompts.
- Generate-plan template adds edge-case, failure-mode, and test-plan sections.
- Disable scout or validation via flags or YAML (`planner.stages.*`).

### Bug fixes

- Jira Tracker broke on blank search (HTTP 400); bounded JQL restores results.
- Atlassian JSON errors surface in tracker messages again (snippet capped).

### Breaking changes

- Dropped `planner.budget.maxCostUsd` and `cost_cap` limits (never enforced).
- Remove lingering keys from `config.yaml` if they are still declared.

## [0.8.0] — 2026-05-03

### What's new

- Generate page shows provider rate limits: countdown, auto-retry banner,
  and rerun when the planner aborts over the wait cap.
- Planner emits richer `rate_limit` stream events (`retrying` vs `aborted`,
  cap seconds, provider, short error snippet). CLI `new-plan` only shows the
  “waiting to retry” spinner for the retrying phase.
- Run SSE ends a rate-limit abort with `done` (partial) only — no extra
  `error` line repeating the same message.

### Bug fixes

- Jira issue search called deprecated `/rest/api/3/search` (Atlassian returns
  HTTP 410). Search now uses `/rest/api/3/search/jql` with clearer 410 errors
  if an old client hits removed endpoints.

## [0.7.2] — 2026-04-28

### Bug fixes

- The console sidebar and dashboard still reported `v0.6.0` after 0.7.1
  because `/api/meta` and `/api/dashboard` had the version hardcoded.
  Both now read from `package.json` (matching the CLI and `/healthz`
  fix in 0.7.1).
- `squad config set tracker --type github` was a no-op stub: it set
  `tracker.type = github` without prompting for owner/repo or PAT and
  skipped the connectivity probe. It now matches the Jira and Azure
  flows — interactive credential prompt, secrets written to
  `.squad/secrets.yaml`, post-config GitHub probe, and an updated
  next-steps hint with `--id <github-issue-number>`.

## [0.7.1] — 2026-04-28

### Bug fixes

- `squad --version` printed `0.6.0` on 0.7.0 — the version string was
  hardcoded in the CLI and the console `/healthz` endpoint. Both now
  read from `package.json` and stay in sync with the installed package.

## [0.7.0] — 2026-04-28

### What's new

- GitHub Issues works as the issue tracker: set owner/repo in config, PAT (or
  `GITHUB_TOKEN` / `GITHUB_HOST`) in secrets, search and import like Jira or
  Azure. Console Secrets page has GitHub host and token fields plus a
  connectivity test; `squad doctor` probes the GitHub REST API.

### Breaking changes

- Linear is no longer a tracker type. Use GitHub Issues, Jira, or Azure, or
  set tracker to `none`. Update `.squad/config.yaml` if you had `linear`.

## [0.6.1] — 2026-04-26

### Bug fixes

- Azure DevOps console tracker search was failing on first load and on text
  search with HTTP 400. WIQL queries now require the team project (`@project`)
  in the WHERE clause; HTTP 400 responses include a clearer hint about
  org/project or WIQL scoping.

## [0.6.0] — 2026-04-29

### Why this release

squad-kit 0.5.0 shipped the console end-to-end. Real users found the visual layer hostile for an admin/console surface — too marketing-y, glow orbs everywhere, dialog positioning glitches under our overflow rules — so 0.6.0 is a redesign-only release. Zero CLI behaviour changes, zero API contract changes. The console adopts a Vercel/Geist-inspired palette: flat near-black surfaces, white text, accent green reserved for status (live planner dot, focus rings, active sidebar, success badges). Every dialog is now portal-rendered and centred reliably. The signature Vercel/Linear move — Cmd+K command palette — is in.

### Added

- console-ui: Cmd+K command palette (powered by `cmdk`) — searches stories, plans, and actions; Linear-style chord shortcuts (`g s` for Stories, `g p` for Plans, `n s` for new story, `?` for the cheatsheet, etc.).
- console-ui: portal-rendered Dialog primitive with focus trap, body scroll lock, ESC + backdrop close, focus restore. Replaces the native `<dialog>` element (and fixes its positioning bugs).
- console-ui: Toast system (`useToast()`) with bottom-right stack, tone-coloured icons, auto-dismiss, manual dismiss, optional inline action.
- console-ui: Confirm provider (`useConfirm()`) — promise-based ergonomics for destructive actions.
- console-ui: Callout component for inline alerts (default / info / success / warning / danger). Replaces every ad-hoc tone block sprinkled through pages.
- console-ui: Density toggle (Comfortable / Compact) in the topbar; persists to `localStorage`, applies via `[data-density]` on `<html>`.
- console-ui: Breadcrumbs in the topbar, derived from the route match tree.
- console-ui: New primitives — `Page`, `Spinner`, `IconButton`, `Tooltip`, `Kbd`, `Field`. All density-aware.
- console-ui: Internal design playground at `/__design` for primitive sanity checks.
- console-ui: `lucide-react` for icons; sidebar letter-icons (`D / S / P …`) replaced with proper Lucide icons.

### Changed

- console-ui: complete design-token rewrite — Geist-inspired graphite scale (12 steps from `--gray-1` to `--gray-12`), accent green reserved for status only. The marketing-site palette stays on the marketing site; the console diverges. CSS variable names that pages already used (`--color-bg`, `--color-surface`, `--color-text`, `--color-accent`, etc.) keep working — their values changed.
- console-ui: layout shell rewritten — sidebar is sectioned (Workspace / Run / Settings) with Lucide icons, project switcher moved into the sidebar header, topbar shows breadcrumbs + density toggle + Cmd+K hint. The decorative `grid-bg` and `glow-orb` divs were removed from the working surface.
- console-ui: every page rewritten through the new `<Page>` wrapper. Inline tone classes (`bg-emerald-…`, `bg-red-…`, etc.) replaced with `<Badge>`, `<Callout>`, and `<Toast>`. Destructive actions go through `useConfirm()`.
- console-ui: charts read CSS variables instead of hard-coded hex codes; near-monochrome palette with green only for the most-recent / success series.
- console-ui: shimmer Skeleton replaces the static `animate-pulse` block.
- console-ui: Markdown viewer adopts a near-monochrome prism theme matching the new tokens.

### Fixed

- console-ui: dialog positioning bugs caused by the native `<dialog>` element interacting with our layout's overflow rules. Now portal-rendered and reliably centred.

### Migration

No breaking changes for CLI users. The `.squad/` file formats, command flags, planner output, tracker integration, and config schema are byte-identical to 0.5.0. If you've installed `squad-kit@0.5.0` globally and run `squad console`, simply `npm i -g squad-kit@0.6.0` and your next `squad console` opens the new look. No `.squad/config.yaml` changes.

### Internal

- console-ui: `cmdk`, `lucide-react` added to `console-ui/package.json` (consumed at build-time only; the CLI runtime dependency tree is unchanged).
- console-ui: extensive primitive coverage with vitest — tests grew by ~25 cases across `Button`, `Badge`, `Spinner`, `Field`, `Page`, `Dialog`, `Toast`, `Callout`, `Confirm`, `Breadcrumbs`, `useDensity`, `CommandPalette`, `useGlobalShortcuts`.

## [0.5.0] — 2026-04-25

### Why this release

squad-kit 0.4.0 made the planner reliable and the partial-plan recovery flow first-class. 0.5.0 makes the whole product **shareable**: a local-first, dark-modern web console that exposes every CLI capability with a UI a teammate can use without learning the commands.

The console isn't a hosted dashboard. It binds to `127.0.0.1`, gates every API request behind a per-session token, and reads/writes the same `.squad/` files the CLI already uses. Open it with `squad console`, share a screenshot of a streaming planning run on Slack, close the tab, keep working in the terminal.

### Added

- `squad console` — open `http://127.0.0.1:4571` (configurable) for a dashboard, stories CRUD, plans browser with diff, live planner streaming via SSE, visual editors for `config.yaml` and `secrets.yaml`, tracker issue search and import, graphical `squad doctor`. Token-gated and loopback-only.
- Persistent run history in `.squad/runs/<runId>.json` (last 20 retained). Dashboard reads from it for cache-hit ratio, token spend sparkline, and run-duration bars.
- `~/.squad/recent-projects.json` — per-user list of project roots you've opened the console against; surfaces in the topbar dropdown.
- Internal: `PlannerEventBus` + `runPlanner({ events, runId, abort })` lets multiple consumers share one run; CLI rendering becomes a bus subscriber.
- Internal: `core/story-mutations.ts` (`createStoryRecord`, `deleteStoryRecord`, `createStoryRecordFromIssue`) is now the single implementation behind the CLI new-story / rm-story commands and the console.
- Internal: `commands/doctor-engine.ts` extracts `gatherContext` and `runAllChecks` so the doctor logic is reusable from the API.
- Internal: `TrackerClient.searchIssues` for Jira (REST `/search`) and Azure (WIQL).
- Build: `pnpm size:guard` — fails CI if the published tarball exceeds 2.5 MB unpacked. Wired into `prepublishOnly`.

### Changed

- `pnpm build` now runs the SPA build (`pnpm -C console-ui build`) before the CLI build (`tsup`) and verifies `dist/console-ui/index.html` was emitted.
- The npm tarball gains a `dist/console-ui/` tree (~700–900 KB gzipped).

### Migration

No breaking changes. CLI commands behave byte-identically. The `.squad/runs/` directory and `~/.squad/recent-projects.json` are added on first console run; `.squad/runs/` is gitignored automatically (managed block).

## [0.4.0] — 2026-04-24

### Added

- `planner.maxOutputTokens` in merged config (default **16384** tokens per model round).
- Interactive `squad new-plan --api` prompt when a planner limit is hit: continue (extends read/context/time/round/output budgets for that run) or stop, with a short billing note up front.
- Incomplete API plans save as `*.partial.md` plus YAML `squad-kit-plan-status: partial`; the CLI exits with code **2** when planning did not finish cleanly (no stack trace for that path).

### Changed

- New plan files are named from the **story folder id** (`NN-story-<id-slug>.md`) instead of slugging the title hint, so paths stay short; `00-overview.md` still carries the human title.
- Intake scaffolding fills more fields from fetched tracker issues (Azure / Jira) when `squad new-story` pulls work item data.
- Agent `squad-plan` templates remind editors not to overwrite the first-line `<!-- squad-kit: … -->` plan metadata comment.

### Fixed

- `squad list` reads `generated by` metadata from the first matching `<!-- squad-kit: … -->` line in the first lines of a plan file, not only line 1.
- `findPlanFor` prefers a non-`.partial.md` plan when both exist for the same story id.

### Site

- Added `robots.txt` and small head metadata tweaks on the Astro site.

## [0.3.0] — 2026-04-24

### Why this release

squad-kit 0.2.2 stabilised rate-limit handling with retries and a softer `squad doctor` warning.
That made failures loud but didn't reduce the underlying token spend: every planning turn
re-sent the cumulative transcript, so costs scaled roughly quadratically with the number of
tool calls. On Anthropic Tier 1 with Opus, that made non-trivial plans structurally infeasible.

0.3.0 adds **prompt caching end-to-end** across Anthropic, OpenAI, and Google. Expected savings
on a typical 10-turn run: ~70% fewer billed input tokens, and — critically on Anthropic —
cached reads don't count the same against your per-minute quota. Tier 1 Opus users should find
moderate plans work where they previously hit 429 from turn 7 onward.

### Added

- Anthropic explicit prompt caching via `cache_control: { type: 'ephemeral' }` on the system
  prompt and the most recent tool-result block each turn (cache TTL rolls forward).
- OpenAI and Google implicit prefix caching (no config required; activated by the stable-prefix
  refactor below).
- `planner.cache.enabled` config knob (default `true`). Configure via `squad config set planner`.
- Run-summary line: `cache hit 68% (22.4k read / 32.9k total)` every `squad new-plan --api` run.
- `squad doctor` now checks `planner cache effectiveness`, reading `.squad/.last-run.json`.
- `.squad/.last-run.json` persistence of planner run stats (git-ignored, per-user).
- `Usage.cacheCreationTokens` and `Usage.cacheReadTokens` on every provider response.
- Deterministic request-body builders (`buildAnthropicBody`, `buildOpenAIBody`, `buildGoogleBody`)
  exposed for testing; dev-mode warning when a turn mutates the cacheable prefix.
- Copy-paste mode (`squad new-plan --copy`) now writes the composed prompt to
  `.squad/.last-copy-prompt.md` and prints a compact summary (mode · story · file · size · est
  tokens · clipboard status) instead of dumping the full 5–10 KB prompt into the terminal.
- Clipboard fallbacks for Linux (`xsel` in addition to `xclip`) and Termux
  (`termux-clipboard-set`). Headless Linux / SSH sessions now surface an actionable reason in
  the summary ("no display server detected — install xclip or xsel, or use the saved file")
  instead of silently skipping.
- `squad config set planner` and `squad config set tracker` print a "▸ Next:" block so users
  know what to run next (`squad doctor` → `squad new-story` → `squad new-plan`).
- `squad tracker link` and `squad migrate` also print "▸ Next:" guidance.
- Managed `.gitignore` block now covers `.squad/.last-run.json` and `.squad/.last-copy-prompt.md`.

### Changed

- System prompt no longer embeds timestamps, random IDs, or absolute host paths (these
  cache-busted the prefix on every turn).
- `squad doctor` Anthropic Tier 1 Opus warning softened from "you will hit ITPM" to "tight but
  viable with caching on."
- `squad config set planner` no longer prompts for `planner.modelOverride`. The interactive
  flow is shorter and less intimidating; power users can still set the override directly in
  `.squad/config.yaml` (documented in `docs/customization.md`).
- `copyToClipboard()` now returns a structured `{ ok, tool?, reason? }` result instead of a
  bare boolean, so callers can explain failures to the user.

### Known limitations

- Google `cachedContents` explicit API not implemented (implicit caching is sufficient for
  single-run CLI use).
- No cross-run persistence of cache stats yet — doctor only reads the most recent run.
- No automatic context compression when transcripts exceed ~50 KB. Caching helps but doesn't
  solve the long-horizon case. 0.4.0 candidate.
- Anthropic 1-hour cache TTL (`ttl: "1h"`) not used — default 5-minute TTL covers single-run.

### Migration

See `docs/migrating-from-0.1.md` §9 "Upgrading from 0.2.x to 0.3.0" for the full path. Short
version: `squad upgrade` and you're done. Caching is on by default; no config edits required.

## [0.2.2] - 2026-04-22

### Fixed

- **Rate-limit retry no longer burns a doomed request.** 0.2.1 capped the auto-retry wait at 30 s. When a provider asked for longer than that (common on Anthropic Tier 1, which regularly asks for 60–180 s), squad-kit would retry *inside the same throttle window* and fail a second time. 0.2.2:
  - Raises the retry cap from 30 s to **90 s**, which comfortably covers the provider-suggested wait for most Tier 1 / free-tier 429s.
  - **Skips the retry entirely** when `Retry-After` is longer than the 90 s cap, and surfaces a dedicated message explaining the decision (`squad-kit did not auto-retry: the provider's 132s wait is longer than our 90s cap, so retrying would just burn another request inside the same throttle window.`) instead of wasting a request and showing the "already retried" variant.

### Added

- **`squad doctor` now reports planner tier vs. model awareness** (check id `planner-tier`). When `planner.provider === 'anthropic'` and the resolved plan model id contains `opus`, the check emits a **warn** with a fix hint suggesting `squad config set planner` to pick Sonnet or Haiku, which live in separate per-model rate-limit buckets on Anthropic Tier 1 (10 k input tokens / minute). For non-Anthropic providers and non-Opus models, the check is `skip` or `ok` — no noise for users who aren't affected.
- `rateLimitMessage` gained a `retrySkippedReason` + `maxRetrySec` field, so the error text can distinguish "we retried and got throttled again" (firm over-quota) from "we did not retry because your wait is longer than our cap" (retry would be pointless). Both cases still surface the same four recovery options.

## [0.2.1] - 2026-04-22

### Fixed

- **`squad new-plan --api` now handles provider rate limits (HTTP 429) properly.** Previously a 429 surfaced the generic `Run \`squad doctor\` to verify models and credentials.` hint, which is misleading — the credentials are fine, the org is just over its per-minute quota. `runPlanner` now:
  - Detects 429s across Anthropic, OpenAI, and Google (new `errorKind: 'rate_limit'` on `ProviderResponse`).
  - Parses `Retry-After` (seconds or HTTP-date) and Google's body-level `retryDelay` field.
  - Retries **once** automatically, waiting the provider-requested time capped at 30 seconds. A new `onRateLimit(waitSec)` callback lets the UI show a "retrying in Ns" notice.
  - When the retry also fails, throws a dedicated error that names the provider, summarises the wait time, and lists four concrete recovery paths: wait and retry, switch planner model (`squad config set planner`), tighten `planner.budget`, or upgrade tier (with a deep-link to each provider's limits page).
- The generic (non-429) provider-error hint now reads `Run \`squad doctor\` to diagnose, or retry — most 5xx errors are transient.`, which is accurate for the actual 5xx / network cases it covers.

### Added

- `detectRateLimit()` and `rateLimitMessage()` in `src/planner/provider-errors.ts`. Both cover all three supported providers and are unit-tested with real-shaped 429 fixtures.

## [0.2.0] - 2026-04-22

### tracker-intake-fetch

**Added**

- `squad new-story --id <ID>` auto-fetches title, description, labels, and attachments (≤ 10 MB each) from the configured tracker. Supported: Jira Cloud, Azure DevOps Services.
- `.squad/secrets.yaml` as a second credential source (after environment variables) for planner keys and tracker tokens. Created with mode `0600` on POSIX; auto-added to `.gitignore`.
- `squad init` now prompts for tracker credentials when a supported tracker is chosen, and offers to save the planner key inline as an alternative to exporting an env var.
- `squad status` shows tracker type, workspace, and credential source (`env` / `secrets.yaml` / `missing`).
- `squad new-story` flags: `--no-fetch`, `--no-attachments`, `--attachment-mb <n>`.
- `squad new-story --no-tracker` — skip tracker id and fetch for a single story in a workspace that normally requires tracker ids. Interactive mode now offers "skip tracker for this story" alongside "enter id" when required.

**Changed**

- `squad new-story` accepts the feature slug as an optional positional; prompts when it is omitted in a TTY (including a picker for existing feature folders). Passing `-y` / `--yes` keeps fail-fast behaviour when the slug is missing. `CI=1` forces non-interactive mode even in a TTY.
- `squad tracker link` accepts both the story path and the tracker id as optional positionals; prompts with a story picker and id input when omitted. `-y` / `--yes` and `CI=1` force non-interactive fail-fast.
- CLI-wide: commands treat missing required input as promptable in a TTY; `-y` / `--yes` and `CI=1` opt out.
- Credential resolution order documented: env var → `.squad/secrets.yaml` → prompt → fail. Applies to both planner and tracker credentials.

**Security**

- `.squad/config.yaml` continues to reject secret-shaped keys (`apiKey`, `token`, …). Secrets live in `.squad/secrets.yaml` only.
- Auto-managed `.gitignore` block covers `.squad/secrets.yaml`, `.squad/stories/**/attachments/`, and `.squad/.trash/`.

### Added

- `squad config` command group with `show`, `set planner`, `set tracker`, `unset planner`, `unset tracker`, and `remove-credential <section>` subcommands. Every field in `.squad/config.yaml` and `.squad/secrets.yaml` can now be edited interactively without opening a text editor.
- `squad init` on an existing workspace now offers **Reconfigure planner / Reconfigure tracker / Overwrite / Cancel** instead of silently bailing. `--force` keeps the old overwrite behaviour for scripts.

- `squad upgrade` self-update command. Detects the package manager used to install squad-kit, fetches the latest version from npm, and runs the appropriate global-install command after confirmation. Refuses dev installs and major version bumps (print-manual-guide instead).
- `squad migrate` command applies one-shot 0.1.x → 0.2.0 structural migrations (delete legacy prompts, gitignore, secrets perms, planner budget defaults, config normalisation). Idempotent; destructive by design; gated behind a confirmation prompt unless `--yes` is passed.
- `squad doctor` command: a full health check covering planner config, tracker credentials, model list probes (no completion calls), `.gitignore` managed block, `secrets.yaml` permissions, legacy `.squad/prompts/`, and `.squad/` layout. `--fix` applies non-destructive repairs only; destructive fixes belong in `squad migrate`.
- `planner.modelOverride` (per-provider) lets you pin a different plan-phase model id without editing squad-kit source.
- `pnpm verify:models` (`scripts/verify-models.ts`) probes provider model list APIs before publish so pinned ids cannot drift unnoticed.
- Clear, actionable error when the planner model returns 404 (upgrade, config override, or `squad doctor`).
- `squad status` marks the planner row with `(override)` when `modelOverride` is active for the current provider.
- Direct planner API (optional): Anthropic, OpenAI, Google. Squad calls the planner for you and writes the plan file.
- Demand-driven context: planner reads files on request via a bounded budget (file count, bytes, wall-clock).
- Interactive picker in `squad new-plan` over un-planned intakes.
- Already-planned guard with `--yes` override.
- `--api`, `--copy`, `--feature`, `--all` flags on `new-plan`.
- `squad init` asks about planner setup; `--planner <provider>` for non-interactive.
- `squad status` shows planner provider, model, and env-var presence.
- `squad list` shows which plans were generated by the API vs copy-paste.
- Visual identity: mint-green brand, custom spinner frames, banner, summary boxes, consistent prefixes across all commands.
- `squad rm` command group: `rm story`, `rm plan`, `rm feature`, each with `--dry-run`, `--trash`, `-y`, and interactive pickers. Deleting a story cascades to the matching plan file and overview row. `.squad/.trash/<timestamp>/` is now git-ignored automatically.

### Changed

- Every user-facing error now ends with a recommended next command (for example, `Run \`squad doctor\` to diagnose`). Failures no longer dead-end users at an error string.
- `ensureGitignore` now includes `.squad/.trash/` in the managed block. Existing users will see the line appended on the next `squad doctor --fix` or any command that calls `ensureGitignore`.
- Anthropic plan model pinned to the versioned Claude API id `claude-opus-4-7` (replacing the prior alias default) and execute remains dated `claude-haiku-4-5-20251001`, per Anthropic’s model overview — run `pnpm verify:models` after changes.
- `new-plan <intake>` is now optional; omit to pick interactively.
- `--no-copy` renamed to `--no-clipboard` (old flag removed). `--copy` now forces copy-paste mode.
- Prompts (`generate-plan.md`, `intake.md`, `story-skeleton.md`) now ship entirely within the squad-kit package. Fresh installs no longer create a `.squad/prompts/` directory. Stale `.squad/prompts/` from 0.1.x installs is ignored at runtime and cleaned up by `squad migrate`.

### Breaking changes for 0.1.x users

- 0.1.x users who upgrade should run `squad migrate` once per repo. A `.squad/prompts/` folder left from 0.1.x is deleted outright (prompts are now bundled in the squad-kit package).
- If you customised `.squad/prompts/*.md`, those customisations are no longer used. The canonical prompts are in the installed squad-kit package. To customise, fork squad-kit and patch `templates/prompts/`. (This is intentional: behaviour was inconsistent before — some commands ignored the user copy — and silent version drift was breaking workflows.)

### Security

- Config loader rejects any YAML entry whose key looks like `apiKey`, `token`, `secret`, or `credential`.

### Known limitations

- OpenAI and Google planner model ids in squad-kit remain provider “latest”-style names for 0.2.0; dated snapshots for those providers are planned for 0.2.1 once verified.

### Non-goals (still deferred)

- OpenAI-compatible generic endpoint (OpenRouter, Ollama, local). Targeted for 0.3.
- `squad implement` command. Targeted for 0.3.
- MCP server, telemetry.

## [0.1.0] - 2026-04-21

First public release.

### Added

- `squad init` — scaffolds `.squad/` with `config.yaml`, prompt templates, and agent slash commands.
- `squad new-story <feature-slug>` — creates `.squad/stories/<feature>/<id>/intake.md` with `attachments/`.
- `squad new-plan <intake-path>` — composes the plan-generation meta-prompt inline with the intake, prints to stdout, and copies to clipboard.
- `squad status` — reports story / plan counts and next global `NN`.
- `squad list [--feature <slug>]` — table of stories and their plan state.
- `squad tracker link <story> <id>` — upserts a tracker id on an existing intake.
- Agent slash-command templates for **Claude Code**, **Cursor**, **GitHub Copilot**, and **Gemini CLI**.
- Tracker id validators for **GitHub**, **Linear**, **Jira**, and **Azure DevOps** (no API calls; format validation only).
- Plan-generation meta-prompt (`generate-plan.md`), intake template (`intake.md`), and plan skeleton reference (`story-skeleton.md`).
- Documentation: `docs/philosophy.md`, `docs/getting-started.md`, `docs/customization.md`, `docs/vs-spec-kit.md`.

[Unreleased]: https://github.com/AzmSquad/squad-kit/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.6.0
[0.5.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.5.0
[0.3.0]: https://github.com/AzmSquad/Squad-Kit/releases/tag/v0.3.0
[0.2.2]: https://github.com/AzmSquad/squad-kit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/AzmSquad/squad-kit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AzmSquad/squad-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.1.0
