# squad-kit 0.3.0

## Why this release

squad-kit 0.2.2 stabilised rate-limit handling with retries and a softer `squad doctor` warning.
That made failures loud but did not reduce the underlying token spend: every planning turn re-sent
the cumulative transcript, so costs scaled roughly quadratically with the number of tool calls. On
Anthropic Tier 1 with Opus, that made non-trivial plans structurally infeasible.

0.3.0 adds **prompt caching end-to-end** across Anthropic, OpenAI, and Google. Expected savings on
a typical 10-turn run: ~70% fewer billed input tokens, and — critically on Anthropic — cached reads
do not count the same against your per-minute quota. Tier 1 Opus users should find moderate plans
work where they previously hit HTTP 429 from turn 7 onward.

## Added

- Anthropic explicit prompt caching on the system prompt and the most recent tool-result block each
  turn (rolling cache).
- OpenAI and Google implicit prefix caching (stable prefix; no extra config).
- `planner.cache.enabled` (default on); configure via `squad config set planner`.
- Run-summary cache line on every `squad new-plan --api` run.
- `squad doctor` check: planner cache effectiveness (reads `.squad/.last-run.json`).
- `.squad/.last-run.json` for last-run planner stats (git-ignored).

## Changed

- System prompt no longer embeds timestamps, random IDs, or absolute host paths (they broke
  cacheable prefixes every turn).
- `squad doctor` Tier 1 + Opus wording softened to “tight but viable with caching on.”

## Known limitations

- Google explicit `cachedContents` API not implemented; implicit caching covers typical CLI use.
- Doctor only sees the most recent run’s cache stats.
- No automatic transcript compression past ~50 KB yet (future work).
- Anthropic 5-minute cache TTL only (sufficient for single CLI runs).

## Migration

`docs/migrating-from-0.1.md` §9 — **`squad upgrade`** and you are done. No config edits required;
caching is on by default.
