# Security Policy

## Supported versions

Only the latest release of squad-kit receives security fixes. Update with the **Update now** button in the app,
or `squad upgrade`.

| Version | Supported |
| ------- | --------- |
| 1.2.x   | ✅        |
| < 1.2   | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Report it privately on GitHub: [Report a vulnerability](https://github.com/AzmSquad/Squad-Kit/security/advisories/new)
(the repository's **Security** tab). Or email the maintainer at **momenysr@gmail.com**. Include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept preferred).
- Affected version(s) and environment (OS, Node version, AI tool and its version).
- Any suggested mitigation, if you have one.

You can expect:

1. **Acknowledgement** within 72 hours.
2. **Initial assessment** within 7 days.
3. **Fix + coordinated disclosure** as quickly as the severity warrants — typically a patch release within 14 days for high-severity issues.

Credit will be given in the release notes unless you prefer to remain anonymous.

## How squad-kit keeps you safe

- **The app runs on your computer only.** It listens on `127.0.0.1`, behind a private link with a token kept in
  `~/.squad-kit/app.json`. Nothing is hosted. It answers only at its own address (Host and Origin are checked on every
  route), and a token in a link works for reads only.
- **Sign-ins stay on this computer.** Tracker tokens and keys live in `~/.squad-kit/projects/<id>/secrets.yaml`
  (mode `0600` on POSIX), never in the project folder or in git. A project moved from 0.x has its
  `.squad/secrets.yaml` moved there once. To run your app, squad-kit copies your project's `.env` files into its own
  copy of the code in `~/.squad-kit/projects/<id>/apps/` (mode `0600`), never anywhere else.
- **Agents never see your secrets.** No agent may read squad-kit's secret files, and the commands squad-kit runs for
  you (tests, setup and release) start without the AI and tracker keys.
- **Agents stay in their lane.** Every step runs with the permissions it needs and no more: the Builder edits only its
  own copy of the code, the Tester cannot change code, and no agent may change the instruction files the next session
  would follow, squad-kit's own `.squad/` folder, or git history. squad-kit checks after each step and puts back what
  an agent changed outside its lane. Text from trackers and pasted messages reaches agents as data, never as orders.
- **Agents get fixed tools, no free commands.** For screenshots, the app and the checks, an agent presses one of
  squad-kit's tools. squad-kit checks every field, does the job itself, and refuses and logs what breaks a check.
- **The project's own commands run in a guard** on Mac and Linux: the tests, setup, the app and the release pipeline
  can't read your keys, sign-ins, browser profiles, squad-kit's own folder or the `.env` files in your project folder.
  They can't change the copy's link to git or git's own folder either, so nothing they write can make squad-kit's own
  git, which runs outside the guard, start a program of theirs.
- **The project's commit hooks run in the same guard, once, on a stand-in.** They look at the change on a branch of
  their own, so a hook cannot move a real branch, plant a hook, change a git setting or reach another ticket. The real
  commit is made after, outside the guard, with your signature if your git signs.
  **Known gap, being closed next:** while they run, hooks share git's store of objects, so a hook built to do harm could
  change a file stored there. A project with no commit hooks is not affected.
- **squad-kit runs no other hook.** Every other git it runs has hooks off: it does not run a project's `pre-push`,
  `post-merge`, `post-checkout` or `post-commit` outside that one commit (a `post-commit` runs on the stand-in). The
  project's own checks have already run in the guard by then. Pushing from your own terminal still runs your hooks.
  A project that uses Git LFS still gets its large files uploaded: a push runs squad-kit's own small `pre-push`, kept in
  its own folder, which does only that.
- **squad-kit's git starts nothing a repo names by itself:** no file monitor (`core.fsmonitor`), no diff program
  (`diff.external`, textconv), and it never looks inside a nested repo. Programs named in your own git settings for the
  network, credentials, filters and merges stay on (`core.sshCommand`, git-lfs): they need a line in a settings file,
  and neither the guard nor an agent's sandbox can write those files.
- **Windows is less protected and not fully tested yet.** There, the agents' own commands and the project's own
  commands have no guard, so they can reach other files on the computer, squad-kit's own too. Use it on projects you
  trust. Settings says so.
- **The engine owns git and the release.** Agents never merge, push or grade their own work.
- **The npm package is built and published by GitHub Actions** from a release tag, with npm trusted publishing (no
  npm token exists) and a signed provenance statement you can check on npmjs.com.

## 0.x commands: credentials

The 0.x commands that still ship (`new-plan`, `auth`, `config` and others) keep their own credential handling:

squad-kit reads API tokens from (in order):

1. **Environment variables** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `SQUAD_PLANNER_API_KEY` for planner; `JIRA_API_TOKEN`, `AZURE_DEVOPS_PAT`, `SQUAD_TRACKER_API_KEY` for trackers.
2. **`.squad/secrets.yaml`** — created with mode `0600` on POSIX; always included in `.gitignore` by `squad init`.
3. **Interactive prompt** — when the terminal is a TTY and the command needs a credential that is missing.

### Anthropic subscription credentials (0.12.0+)

The Anthropic planner can authenticate with a Claude subscription instead of an API key. That path resolves, in order: **`CLAUDE_CODE_OAUTH_TOKEN`** → **`planner.anthropicOauthToken` in `.squad/secrets.yaml`** → the **OS credential store** managed by Claude Code.

- The OAuth token is a credential and is treated as one: it lives in `.squad/secrets.yaml` only (git-ignored, `0600` on POSIX), is masked everywhere it is displayed, and is rejected by name if it appears in `.squad/config.yaml`.
- squad-kit **never reads** the OS credential store. It checks only whether an entry **exists** (on macOS via `security find-generic-password -s "Claude Code-credentials"`, never `-w` / `-g`) and leaves the reading to the Claude Agent SDK.
- In subscription mode, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are **removed from the planner subprocess environment** (case-insensitively). Both outrank the subscription credential inside Claude Code, so an inherited one would silently redirect usage to API billing. The parent shell is not modified.
- `squad auth logout` removes **only** the token squad-kit stored. It never deletes the user's global Claude Code credential.
- Persisted run records (`.squad/runs/*.json`, `*.events.jsonl`) carry the resolved auth **mode** and `apiKeySource` only — never a token, key, email, or organization. Account details are fetched live for display and never written to disk.

### Non-goals

- `.squad/config.yaml` must never contain secrets. Loading it with a key whose lowercased name is exactly `apikey`, `api_key`, `token`, `oauthtoken`, `anthropicoauthtoken`, `secret`, `credential`, or `credentials` raises a loud error. Matching is exact rather than substring so that legitimate keys such as `planner.maxOutputTokens` keep loading; new credential-shaped keys must be added to that list by name.
- squad-kit does not **store** credentials in an OS keychain. It will detect and use a Claude Code login held in one (see above), but its own secrets model remains the `.squad/secrets.yaml` file: inspectable, excluded by ignore rules, and portable.
- Credentials are never logged. Tracker error messages redact tokens; planner provider errors do the same.

### Known limitation — enterprise managed settings

squad-kit runs the Agent SDK with `settingSources: []`, which prevents it from reading user, project, and local settings files. An ordinary user-level `apiKeyHelper` therefore cannot redirect a subscription run. **Policy settings are always merged regardless**, so an enterprise **managed-settings** `apiKeyHelper` deployed by MDM is still honoured and still outranks the login credential. On a managed device, `planner.auth.anthropic: subscription` may resolve through the organization's helper. This was established by reading the credential resolver in the bundled `claude` binary, not by testing on a live managed device. `squad auth status` reports the `apiKeySource` the SDK actually resolved.

## Scope

squad-kit runs on your computer and starts AI agents (Claude Code today) that read and change code in their own copy
of your project and run commands there. It calls network APIs you set up: your tracker, your code host and your AI
tool. Reports in scope include:

- A secret (a sign-in, a token, a key) reaching an agent, a log, a report file or git.
- The app answering anyone other than you, from this computer or another one.
- An agent getting past its permissions: writing outside its copy, changing instruction files, git history or
  `.squad/`, or merging or pushing.
- Arbitrary file read/write outside the project caused by malformed input (for example path traversal through a
  ticket name or an attachment).
- Command injection through anything squad-kit runs for you.
- Supply-chain concerns in shipped dependencies or in how the package is built and published.

Out of scope:

- Vulnerabilities in the AI tools themselves (Claude Code and others). Report those upstream.
- What the code an agent writes does in your project. squad-kit checks it (tests, review, proof), and you approve it
  before it merges.
