---
title: Migrating from 0.1.x
description: Upgrade a squad-kit 0.1.x repo to 0.2.0 without losing stories, plans, or credentials.
slug: migrating-from-0.1
---

# Migrating from 0.1.x

squad-kit **0.2.0** changes how configuration, credentials, and prompt templates are owned. This guide is for **every** team that installed **0.1.x** and has an existing **`.squad/`** tree: it walks you from a 0.1.x install to 0.2.0 **without** touching your story or plan files, and with clear steps for prompts and secrets. The short version: **run two commands per repository** (upgrade the CLI, then `squad migrate`) — **no data loss** for stories, plans, or work already under **`.squad/stories/`** and **`.squad/plans/`**.

You do **not** need to read **`CHANGELOG.md`** or the rest of the docs in parallel: everything required to get to a **stable 0.2 workspace** is on this page, with [cross-links](customization.md) only for optional depth ( **`squad config`**, **forking prompts**, and ongoing maintenance). If you are **new to squad-kit** and not upgrading, start with [getting-started.md](getting-started.md) instead.

**Platform note:** the commands below are written for **macOS** and **Linux**. On **Windows**, use the same `squad` subcommands; **`0600`** file modes are a no-op, and `squad doctor` marks permissions as **skip** for **`secrets.yaml`**.

**Idempotence:** you can run **`squad migrate`** on a repository that was **initialised in 0.2**; pending steps will be **empty** and the tool exits with *No migrations needed*. The same is true of **`squad doctor --fix`** when there is **nothing** to repair — it is **safe to run twice**.

**Time budget:** for a typical repo, **dry-run** and **migrate** each take **seconds**; **`squad doctor`** may add **tens of seconds** when it probes **planner model lists** and **tracker HTTP** endpoints.

## TL;DR

```bash
# once per machine
pnpm add -g squad-kit@0.2.0   # or: npm install -g squad-kit@0.2.0 — or: squad upgrade

# once per repo that uses squad-kit
cd your-project
squad migrate --dry-run       # preview what will change
squad migrate                 # apply, then:
squad doctor                  # confirm a clean bill of health
```

If you customised **`.squad/prompts/`** in 0.1.x, read [§6 — If you customised `.squad/prompts/`](#6-if-you-customised-squadprompts) **before** running `squad migrate`.

## What actually changes

### On disk

| Change | Why |
| --- | --- |
| The **`.squad/prompts/`** directory is **deleted** by `squad migrate` when it still exists. | In 0.2.0, the three template files (**`intake.md`**, **`generate-plan.md`**, **`story-skeleton.md`**) ship **inside** the **`squad-kit` npm package** under **`templates/prompts/`**. The 0.1.x copy in your repo was read inconsistently across commands and could silently drift from the CLI you were running. |
| **`.squad/secrets.yaml`** may appear (or start receiving keys) when you use the planner or a supported tracker with stored credentials. | API tokens stay **out** of **`.squad/config.yaml`**, so config can be committed and secrets stay git-ignored. The **`squad migrate`** command does not invent an empty secrets file, but 0.2 creates or updates it when you save keys via **`squad init`**, **`squad config set planner`**, or **`squad config set tracker`**. |
| **`.gitignore`** gains a **managed squad-kit block** (appended; existing content is left in place) covering **`.squad/secrets.yaml`**, **`.squad/stories/**/attachments/`**, and **`.squad/.trash/`**. | Stops accidental commits of credentials, large attachment blobs, and trash from **`squad rm`**. The migrate step **`Ensure .gitignore managed block`** calls the same `ensureGitignore` helper other commands use. |
| **`.squad/secrets.yaml`** is **`chmod`’d to `0600`** on POSIX. | Treat the file like **`~/.ssh/id_rsa`**. On Windows, chmod is skipped; doctor follows the same rules. |
| **`.squad/config.yaml`** is **re-serialised** in canonical form. | Formatting is normalised so later **`squad config set`** diffs stay small. **All comments in your `config.yaml` are dropped** when the normalisation migration runs. |
| **Planner `budget` defaults** are backfilled for enabled planners. | 0.2.0 adds **`planner.budget`**; defaults are **25** max file reads, **50 000** context bytes, **180** seconds (see `mergePlanner` in the CLI). If the **`planner:`** key is absent, there is nothing to backfill. |

**Path layout (0.2.0):** the CLI resolves **`.squad/config.yaml`**, **`.squad/secrets.yaml`** (new file for stored keys), **`.squad/.trash/`** (for **`squad rm --trash`**), and the **legacy** **`promptsDir`** at **`.squad/prompts/`** only so **`squad doctor`** and **`squad migrate`** can detect a stale tree. Fresh 0.2 installs never create **`.squad/prompts/`**.

### Behaviour

| Behaviour | 0.1.x | 0.2.0 |
| --- | --- | --- |
| Plan meta-prompts | **`.squad/prompts/*.md`** (user-editable) | Bundled in the npm package (**`templates/prompts/`**). Fork to customise. |
| API credentials | Environment variables only for many flows | **env var** → **`.squad/secrets.yaml`** → **prompt (TTY)** → **fail** |
| `new-story` with a tracker id | Format validation only | **Auto-fetches** title, body, labels, attachments from **Jira Cloud** or **Azure DevOps** (when configured). |
| Missing required input on a command | Error + exit | Interactive prompt in a TTY; **`-y`**, **`--yes`**, and **`CI=1`** keep fail-fast behaviour. |
| Deleting a story | **`rm -rf`** + manual overview cleanup | **`squad rm story`** — cascading, reversible with **`--trash`**. |
| Editing config | Hand-edit YAML | **`squad config show` / `set` / `unset` / `remove-credential`**. |

### How `squad migrate` maps to the above

The `squad migrate` command runs up to **five** pending migrations, each skipped when already applied:

1. **Remove legacy `.squad/prompts/`** — recursive delete of the old prompts directory (safety: path must look like **`.squad/prompts`** under the resolved workspace root).
2. **Ensure `.gitignore` managed block** — idempotent append of the squad-kit block (and **`.squad/.trash/`** line when upgrading an older block).
3. **Tighten `.squad/secrets.yaml` permissions** — `chmod 600` on POSIX if the file exists.
4. **Backfill `planner.budget` defaults** — when **`planner:`** is present and the planner is enabled, **`saveConfig`** runs so merged defaults are written.
5. **Normalise `.squad/config.yaml` formatting** — load, then **`saveConfig`**, so comments are lost but values stay equivalent.

In logs and in [`migrate.ts` source](https://github.com/AzmSquad/Squad-Kit/blob/main/project/src/commands/migrate.ts), these are labelled **`legacy-prompts`**, **`gitignore`**, **`secrets-perms`**, **`planner-budget-defaults`**, and **`config-normalize`**. You do not need to know the ids to operate the CLI, but they match what you will see in **issues** and **CI logs** if you ever file a bug report about migration behaviour.

**Dry run** (`squad migrate --dry-run`) lists those actions with a human-readable description and **applies nothing**. **Apply** uses a confirmation prompt unless you pass **`--yes`** (required in non-interactive environments without a TTY unless **`--yes`** is set).

### `squad upgrade` (optional path to 0.2.0)

**`squad upgrade`** is new in 0.2.0, so you will not have it until you have **some** 0.2.x binary available (after a first manual global install, or via `pnpm` / `npm`). It reads the **installed** package version, compares to **latest** on the npm registry, **detects which package manager** was used for the global install, and — after **Yes** on the prompt (or **`squad upgrade --yes`**) — runs the same install you would run by hand (for example `pnpm add -g squad-kit@<version>`). Use **`squad upgrade --check`** to print the command **without** executing. It **refuses** **development installs** (checkout next to the binary) and **major** version bumps (you must install and read the changelog deliberately). After a successful upgrade it suggests **`squad migrate`** for any repo that still has 0.1-era layout.

## Before you upgrade: a 60-second checklist

- **Commit or stash** local changes. `squad migrate` rewrites **`.squad/config.yaml`**, may touch **`.gitignore`**, and deletes **`.squad/prompts/`** if present — you want a clean diff.
- **Skim `.squad/prompts/`** for any edits. If you changed anything, read [§6](#6-if-you-customised-squadprompts) **before** migrate.
- **Find planner / tracker credentials** — if they only live in env vars today, that still works in 0.2. Decide if you will move some keys to **`secrets.yaml`** for shared machines (optional; both paths are supported).
- **Confirm the CLI version** you are about to leave behind. On 0.1.x, **`squad migrate` does not exist**; the practical order is **install 0.2.0 first**, then run **`squad migrate`** in each repo. Use `squad --version` to confirm you are on **0.1.x** before the global install step if you are auditing a machine.
- If this repo has **no** **`.gitignore`** yet, plan to **`git diff .gitignore`** after migrate (or `squad doctor --fix`) so you see the managed block land.
- **Back up the prompts directory** to another path **outside** **`.squad/prompts/`** if you edited those files. The migration itself will not do this for you — see [§6](#6-if-you-customised-squadprompts) for the supported backup commands.
- **Multi-repo note:** if you use **`project.projectRoots`** in **`config.yaml`**, the squad workspace is still a **single** **`.squad/`** at the **root** that owns stories and plans. Run **`squad migrate`** **once** from that root; you do not run migrate per subfolder.

## Step-by-step upgrade

### 1. Update the CLI

Install the 0.2.0 global binary so **`squad migrate`** and **`squad doctor`** are available:

```bash
pnpm add -g squad-kit@0.2.0
# or: npm install -g squad-kit@0.2.0
# or: squad upgrade   # detects global package manager, confirms, then runs the install
```

**Verify:** `squad --version` should print **`0.2.0`**.

**Expected output (example):** a single line with `0.2.0` (or your pinned patch). If the version is still 0.1.x, the shell may be using another binary — check `which squad`.

On a machine that **already** has a 0.2.x `squad`, you can move to the latest **patch** with **`squad upgrade`** instead of typing `pnpm` / `npm` yourself. You **cannot** use `squad upgrade` to jump from **0.1.x** to **0.2.0** until a 0.2 binary exists on the `PATH` — the first install is still `pnpm add -g squad-kit@0.2.0` or equivalent.

If this fails, see [§8 — If something goes wrong](#8-if-something-goes-wrong).

### 2. Dry-run the repo migration

```bash
cd your-project
squad migrate --dry-run
```

**Purpose:** Show every **pending** migration (name + one-line description) with **no writes**.

**Expected output:** A `squad migrate` banner, the workspace path, a line per pending migration (for example *Remove legacy `.squad/prompts/`* and *add squad-kit managed block to `.gitignore`*), and *Dry run: no changes applied. Re-run without --dry-run to apply.*

**Verification:** Read the list and confirm you understand each line (especially the prompts delete and config normalisation). If the tool prints `No migrations needed. Your .squad/ is up to date.`, you are already on the 0.2 layout — run **`squad doctor`** and skip to sanity checks.

**Tip:** if you are unsure which directory **`squad`** will treat as the workspace, **`cd`** to the **repository root** (where **`.squad/config.yaml`** lives) first. The CLI walks **up** from the current working directory, like **`git`**, so running migrate from a **subfolder** of the repo is fine as long as a parent contains **`.squad/`**.

If this fails, see [§8](#8-if-something-goes-wrong).

### 3. Apply the migration

```bash
squad migrate
```

**Purpose:** Apply each pending step in order: delete legacy prompts, update **`.gitignore`**, **chmod** **`secrets.yaml`** if needed, backfill planner budget via **`saveConfig`**, normalise **`config.yaml`**.

**Confirmation:** In an interactive TTY, you are asked *Apply N migration(s)?* — default **Yes**. In CI or non-TTY, pass **`squad migrate --yes`** (otherwise the command **refuses** to apply, with an explicit error). **`CI=true`** is treated as non-interactive for the same reason as other commands.

**Per-action log:** A spinner per migration, then **`… — applied`**, and finally **`Applied N/N migration(s).`** plus a reminder to run **`squad doctor`**.

**If you answer *No* at the prompt:** the CLI prints *Cancelled. No changes applied.* and exits **0** — your tree is unchanged; you can fix whatever worried you and re-run. Partial application does **not** happen: either **all** pending migrations in this invocation succeed, or a failure stops the run with a **non-zero** exit after the failing step.

**Verification:** **`git status`** and **`git diff`** should show the expected file changes. Prompts directory should be gone if it existed.

If this fails, see [§8](#8-if-something-goes-wrong).

### 4. Verify with doctor

```bash
squad doctor
```

**Purpose:** After migrate, the workspace should be structurally sound. `squad doctor` runs **thirteen** named checks in order; each line is **`✓` (ok)**, **`!` (warn)**, **`✗` (fail)**, or **`·` (skip)**:

1. **`.squad/` directory structure** — **`stories/`**, **`plans/`**, and the squad root exist (or are fixed with **`--fix`**).
2. **`.squad/config.yaml` readable** — parseable YAML matching the 0.2 schema expectations.
3. **`.gitignore` managed block** — contains the squad-kit block that ignores **`secrets.yaml`** (marker: the pattern **`.squad/secrets.yaml`**).
4. **`.gitignore` includes `.squad/.trash/`** — older repos may have the first block from an earlier 0.2 beta without the trash line; **`--fix`** appends to the same managed block.
5. **`.squad/secrets.yaml` permissions** — **`0600`** on POSIX, or **skip** on Windows.
6. **`.squad/secrets.yaml` parseable** — valid YAML object when the file exists.
7. **Legacy `.squad/prompts/` directory** — should be **ok** (absent) after migrate; if **warn**, run **`squad migrate`**.
8. **Planner configuration** — when the planner is enabled, provider, **`planner.budget`**, and optional **`planner.modelOverride`** shapes are valid.
9. **Planner credential resolves** — API key from env or **`secrets.yaml`** (or **skip** if planner off).
10. **Planner model resolves at provider** — the resolved plan model id appears in the provider’s public model list (HTTP probe, not a paid completion); **fail** if the id was retired.
11. **Tracker configuration** — Jira has a host, Azure has org + project, etc. (**skip** if **`tracker.type: none`**).
12. **Tracker credential resolves** — PAT / token can be built for the client (**skip** if no tracker or no API client).
13. **Tracker connectivity** — live **Jira** or **Azure** probe when those clients are in use; **skip** when there is no credential.

The summary line looks like: **`N ok · W warn · F fail · S skip`**. **Exit code 1** if any check is **fail** (so CI can detect a broken workspace).

**First run on a healthy migrated repo:** Most rows should be **ok**. Exceptions that are still normal on day one:

- **Planner / tracker credential** lines may be **skip** (feature disabled) or **fail** if env-only secrets are not visible in the environment you ran doctor in — re-run in a shell where your **`.env` / shell exports** are loaded, or save keys with **`squad config set`**.

- **Secrets permissions** is **skip** on Windows; **ok** on POSIX with **`600`**, or a **warning** with **`squad doctor --fix`** to chmod.

- **`squad doctor --fix`** only applies **non-destructive** repairs (missing **`.squad/`** dirs, **`.gitignore`** block, trash pattern line, `chmod` on **`secrets.yaml`**). It does **not** remove legacy **`.squad/prompts/`** — that remains **`squad migrate`**.

If this fails, see [§8](#8-if-something-goes-wrong).

### 5. Try the new flow

Your **stories** and **plans** on disk were **not** part of the migration. Confirm counts and one optional new workflow:

```bash
squad status              # story + plan counts should match your expectations
squad list                # every plan file still listed
squad new-plan --api      # optional: try direct planner on an un-planned intake (if planner is enabled and keys resolve)
```

**What to look for:** **`squad status`** should report the same story and plan **counts** as before the upgrade (unless you had uncommitted work). **`squad list`** should still list every plan row you expect. **`squad new-plan --api`** exercises the 0.2 **direct planner** path: if you had only ever used copy-paste in 0.1.x, this is a good smoke test that **`planner`**, **credentials**, and **budget** are wired correctly. If the planner is **disabled**, use **`squad new-plan`** (or **`--copy`**) instead — the important check is that **plan discovery** and **intake** flows still work.

If this fails, see [§8](#8-if-something-goes-wrong).

## 6. If you customised `.squad/prompts/`

**Fact:** `squad migrate` **deletes** **`.squad/prompts/`** entirely. There is **no** merge, rename-in-place, or “keep the diff” option inside the command.

**Before** running migrate, **back up** anything you need:

```bash
cp -R .squad/prompts .squad/prompts.bak      # or:
git mv .squad/prompts legacy-prompts-backup  # commit the rename so git keeps history
```

**After** you are on 0.2, compare your backup to the package templates: **`node_modules/squad-kit/templates/prompts/*.md`** in a normal install, or the repo path **`project/templates/prompts/`** when developing squad-kit from source. The three files are **`intake.md`**, **`generate-plan.md`**, and **`story-skeleton.md`**.

If your edits are still valuable, the **supported** path is to **fork squad-kit** and ship your own build:

```bash
git clone https://github.com/AzmSquad/Squad-Kit your-org-squad-kit
cd your-org-squad-kit && cd project
# patch templates/prompts/*.md to match your customisations
pnpm install && pnpm build
pnpm link --global
```

Then the `squad` you run in any project uses your fork’s prompts. Alternatively, publish a scoped package (for example **`@your-org/squad-kit`**) and install that instead of upstream. For more detail, see [Forking to change prompts in **customization.md**](customization.md#forking-to-change-prompts).

**Why 0.2.0 is strict about this:** Silent drift between a checked-in **`.squad/prompts/`** copy and the version of the CLI you ran was a real support burden in 0.1.x. The 0.2 contract is explicit in [**philosophy.md**](philosophy.md#why-markdown-prompts-not-embedded-logic): **the CLI you installed defines the default prompts** — upgrade the package, or maintain a **fork** if you need different templates.

**Diff workflow:** after you unpack upstream **`templates/prompts/*.md`**, a three-way check is enough for most teams: (1) your **`prompts.bak`**, (2) the new package **defaults**, and (3) a short list of *behaviour* changes you care about (for example, verification boilerplate in **`generate-plan.md`**). You only need a **text merge** in your **fork** if you are carrying forward phrasing, not a merge inside **`squad migrate`**.

## 7. If your credentials were in env vars

- **Env vars still work in 0.2.0** with the same resolution order as the rest of the tool: **environment variable** first, then **`.squad/secrets.yaml`**, then an **interactive prompt** in a TTY, then **exit with a recovery hint**. Nothing **forces** you to move keys into a file.
- If you **want** shared-on-disk storage (for example so teammates are not re-exporting variables), run **`squad config set planner`** or **`squad config set tracker`**, choose the provider, and when prompted opt to **save to `secrets.yaml`**. The file is created or updated, then **`saveSecrets`** **chmod**’s to **`600`** on POSIX.
- To **remove** a stored key but **keep** the service enabled (fall back to env only), use **`squad config remove-credential planner`** or **`squad config remove-credential tracker`**.
- **`.squad/secrets.yaml`** is **git-ignored** and mode **`600`** on POSIX. **Do not** commit it; treat it like local SSH material.

**`squad status`** in 0.2 shows whether each provider’s key came from **env** vs **`secrets.yaml`** — use it after a migration to confirm your team sees **consistent** `source=` lines. **`squad config show`** prints a **masked** view of the same; neither command echoes raw secrets. If you use a **direnv**-style **`.envrc`**, run **`squad doctor`** in the same environment your editors use, or you may get **false “missing key”** failures.

**Jira and Azure** store host / org / project in **`config.yaml`** and tokens in **`secrets.yaml`** (or the documented env var names, which vary by release — **`CHANGELOG.md`** and **customization.md** are the source of truth for your installed version). **GitHub** and **Linear**-style paths may still be primarily format-based; keep **`squad doctor`** green before relying on **auto-fetch** for Jira or Azure.

## 8. If something goes wrong

- **`squad migrate` says there is nothing to do.** The message is **`No migrations needed. Your .squad/ is up to date.`** — a safe no-op. Run **`squad doctor`** to double-check. No fix command is required.
- **Doctor reports a missing `.gitignore` block** (or missing **`.squad/.trash/`** line in an older block). Run **`squad doctor --fix`**, which appends the managed block or updates it idempotently. If the repo has **no** **`.gitignore`**, **`ensureGitignore`** can **create** one. Command: `squad doctor --fix`.
- **Doctor warns about `secrets.yaml` permissions** (not “skip / Windows”). Run **`squad doctor --fix`**; it runs **`chmod 0600`** on the file. On Windows the permissions check is skipped by design. Command: `squad doctor --fix`.
- **Planner hits HTTP 429 (rate limit) during `squad new-plan --api`.** `squad-kit` 0.2.1+ detects 429s, retries once automatically after the `Retry-After` hint (capped at 30 s), and — if that retry also fails — shows a rate-limit-specific error instead of the old "verify models and credentials" hint. Recovery paths, in order of effort: (a) wait 60 s and rerun; most provider limits reset per minute. (b) switch to a smaller planner model: **`squad config set planner`** and pick a cheaper id (for Anthropic, `claude-haiku-*` variants are comfortably under most tier quotas). (c) tighten **`planner.budget`** in **`.squad/config.yaml`** (lower `maxContextBytes` and `maxFileReads`) so each request carries fewer tokens. (d) upgrade your provider tier — each provider's link is in the error message, or visit the provider's console directly (Anthropic: `https://console.anthropic.com/settings/limits`). Command: `squad config set planner`.
- **Planner model is missing or the provider returns 404/401 for the list probe.** The pinned id may be retired. Option A: **`squad upgrade`** to a release that updates provider pins. Option B: set **`planner.modelOverride.<provider>`** in **`.squad/config.yaml`** or run **`squad config set planner`** and pick a model that appears in the provider’s current catalog. For background, see [Model override in **customization.md**](customization.md#model-override) and the [`[0.2.0]` section of **CHANGELOG.md** on GitHub](https://github.com/AzmSquad/Squad-Kit/blob/main/CHANGELOG.md).
- **Comments in `config.yaml` vanished.** **Expected** after the *Normalise* migration — see [§3 — On disk](#on-disk). Recover text from history: `git show HEAD~1:.squad/config.yaml` (adjust revision). Re-apply any commentary into team docs if you need it, because future **`squad config set`** runs will rewrite YAML again. Command: `git show <commit>:.squad/config.yaml` (or your host’s equivalent).
- **A story was deleted with `rm -rf` instead of the CLI.** Restore from **git** if tracked: `git restore` the paths, or `git checkout -- .squad/...` as appropriate. Going forward, use **`squad rm story --trash`** so files move under **`.squad/.trash/<timestamp>/`**, which is git-ignored but recoverable on disk. Command: `squad rm story --trash` (after the story exists again, if needed).
- **`squad upgrade` refuses to run.** The command **exits** for (a) **development** installs (source next to the binary) — use a manual **global** install, e.g. `pnpm add -g squad-kit@latest` / `npm i -g squad-kit@latest`. It also (b) **refuses major version jumps** and prints a **manual** install command and a **CHANGELOG** link. Read the new major’s `CHANGELOG` before forcing a major bump. Command for patch/minor: `pnpm add -g squad-kit@0.2.0` (or the printed command from the error). For more on **`squad config`**, **`squad rm`**, and **doctor** flows, see [customization.md](customization.md).
- **Migrate refuses to run in CI without flags.** The message is explicit: in a **non-interactive** shell, **`squad migrate`** without **`--yes`** exits so you do not apply destructive changes accidentally in automation. In pipelines, run **`squad migrate --yes`** (after **`--dry-run`** in a prior job if you want a human gate). Command: `squad migrate --yes`
- **DoctorJSON for scripting:** pass **`squad doctor --json`** to get machine-readable check output (same checks as the default table). Handy for CI smoke tests. Pair with a query tool or **`jq`** to fail the job on any **`status: "fail"`** entry. Command: `squad doctor --json`
- **Registry or network errors during `squad upgrade`.** The command already suggests a **manual** `pnpm` / `npm` install if it cannot reach **registry.npmjs.org**. Fix DNS or proxy, then re-run the printed install. Command: `pnpm add -g squad-kit@0.2.0` (replace version as needed)
- **A migration step throws “Refusing to delete suspicious path”** for **`.squad/prompts`**. The delete has a **safety** check that the path contains **`.squad`** and **`prompts`**. If your layout is a symlink or an unusual mount, run **`squad doctor`** to confirm **`paths`** look normal, or remove the bad link **by hand** after reading the error. Command: `squad doctor`

## 9. What didn't change

- **Stories and plans** under **`.squad/stories/`** and **`.squad/plans/`** are **not** moved or bulk-edited by `squad migrate`. Your narrative content and the **`NN-story-<slug>.md` plan shape** you already use remain valid.
- **Field names in `config.yaml`** stay **compatible** at the semantic level. New 0.2 pieces (**`planner`**, **`planner.budget`**, **`planner.modelOverride`**, expanded tracker options) are **additive** once you are on 0.2 and run **`saveConfig`**-backed commands.
- **Agent slash files** (for example **`.claude/commands/`**, **`.cursor/commands/`**, **`.github/prompts/`**, **`.gemini/commands/`**) are only **regenerated** if you re-run something like **`squad init --force --agents …`**. A normal `squad migrate` does not touch them.
- **Plan file format** and **overview** patterns are unchanged: 0.1.x plan files work with the 0.2.0 CLI and agents.
- **Workspace discovery** (walking **up** from the current directory to find **`.squad/config.yaml`**) is the same model as 0.1.x — only the files inside **`.squad/`** and the managed **`.gitignore`** block change.
- **Tracker id validation** for GitHub / Linear and filename conventions you already set stay in effect; 0.2 **adds** opt-in **fetch** behaviour for Jira and Azure when those backends are selected.

The migration is **intentionally narrow**: it does not rewrite your story bodies, renumber plan **`NN`**, or touch **`00-index.md`** / feature **`00-overview.md`** except indirectly when you run separate commands (for example **`squad rm`**) that always updated those files in 0.1.x as well.

**Post-upgrade hygiene:** when you are satisfied with the repo state, commit the **`.squad/config.yaml`**, **`.gitignore`**, and any **agent** files you intentionally changed. **Do not** add **`secrets.yaml`** — it should stay untracked. A typical commit message: *`chore: migrate squad-kit workspace to 0.2 layout`*.

**Ongoing version bumps** after 0.2.0: use **`squad upgrade`** for **same major** line updates, and **`squad doctor`** after any install that might change how **`gitignore`** or **`planner` pins** behave. Re-read the **[0.2.0] → newer** section of the upstream **`CHANGELOG.md`** when you move **minor** or **major** — squad-kit will refuse blind major upgrades via **`squad upgrade`** for good reason.

Need more? Start with [getting-started.md](getting-started.md) for the refreshed quickstart or [customization.md](customization.md) for **`squad config`**, **`squad rm`**, and **`squad doctor`** in depth.
