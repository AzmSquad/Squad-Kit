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
- **Agents are kept from your secrets.** No agent may read squad-kit's secret files, and the commands squad-kit runs for
  you (tests, setup and release) start without the AI and tracker keys.
- **Local files stay out of agents' reach.** An engineer can name files git does not carry, like `.env.dev`. Each one goes
  in a story's copy for the project's own tests and app, and agents are refused it by its exact path. The project's own
  commands can still read it, and a test the Builder wrote is one of those. So stories use values kept for them on this
  computer: give them local test values, never real ones. A file with secrets that is already in git is not covered.
- **Docker stays closed, with one opening.** Project commands cannot reach Docker. squad-kit opens that one socket for its own
  `docker compose up`, from the project's settings, when an engineer locked every compose file the command names. A story
  cannot change those files. What runs inside the containers is the story's code, and the image builds run its Dockerfile.
- **Agents stay in their lane.** Every step runs with the permissions it needs and no more: the Builder edits only its
  own copy of the code, the Tester cannot change code, and no agent may change the instruction files the next session
  would follow, squad-kit's own `.squad/` folder, or git history. squad-kit checks after each step and puts back what
  an agent changed outside its lane. Text from trackers and pasted messages reaches agents as data, never as orders.
- **Agents get fixed tools, no free commands.** For screenshots, the app and the checks, an agent presses one of
  squad-kit's tools. squad-kit checks every field, does the job itself, and refuses and logs what breaks a check.
- **Each project has a network level, one policy for both guards.** **Standard** (the default): the agents' commands
  reach any website but known-bad ones (tunnels, paste and file-drop sites, request catchers). **Strict**: only the
  official package and download sites of common tools and the websites the project allows. **Off**: nothing outside this
  computer. The known-bad sites are closed on every level and cannot be allowed. On Standard a harmful package can reach
  the internet, but the keys and sign-ins it would take stay hidden. The project's own commands (tests, setup, the app)
  stay open on Standard and Strict; on Off a Mac closes them to all but this computer, and Linux leaves them open. A
  refused site never stops a story: the story gets a plain line and engineers a log on Harness → Safety.
- **The project's own commands run in a guard** on Mac and Linux: the tests, setup, the app, the release pipeline and the
  commit hooks. **The guard stops accidents and most bad behaviour, but it is not a wall against code built on purpose to
  break out.** On a Mac its rules start from allowing everything and block a list. Use squad-kit on projects and tickets you
  trust, and read what the Builder changes.

  What it stops:
  - Reading the usual places for keys and sign-ins (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.docker`, the
    GitHub and cloud sign-ins, the keys into a runtime's virtual machine, an `.npmrc` with a token), browser profiles and
    squad-kit's own folder. A place it does not know about is not hidden.
  - Reading the `.env` files in your project folder. On a Mac, all of them. On Linux, the ones it finds 3 folders down when
    a command starts, outside folders such as `node_modules`. One exception: the setup squad-kit runs in your own
    checkout after a merge reads that checkout's `.env` files, as it does when you run it yourself (a database setup
    needs them). It still reads no other `.env` file, key or sign-in.
  - Writing outside its copy, the proof folder, the temp folder, the package caches and the project's own download
    folder. `~/.cache`, `~/Library/Caches` and each tool's own folder in your home (`~/.gradle`, `~/.m2`, `~/.nuget`,
    `~/.pub-cache` and the like) stay read only: your own tools run programs from there. Each tool is pointed at the
    project's own folder instead, by its own setting. A tool that still writes in your home is run once more with a home
    of the project's own, where your files are seen only through links that stay read only, and your keys and sign-ins
    are left out. Programs you installed stay read only too: Flutter's SDK, a version manager's folder, and the Gradle your
    project's wrapper uses when squad-kit links yours in. The copy cannot be moved, and git's own folder cannot be changed
    or moved, so nothing written there can make squad-kit's own git start a program.
  - Reaching a container runtime. A container can mount any folder, so a command that reaches Docker could read everything
    above. Connections to the sockets of Docker Desktop, colima, lima, Rancher Desktop, OrbStack, Finch and Podman are
    refused where the guard knows them. A runtime that listens somewhere else is not covered. **1.2.0 and 1.2.1 did not
    have this**: there, a command could read hidden files through Docker when Docker was running. If a project's own tests
    need Docker, an engineer can allow its socket's folder in Settings, knowing that this opens what the guard hides.
  - Signalling other programs. On a Mac a signal reaches only what the command started. On Linux other programs are not
    visible at all.

  What it does not stop:
  - **The network.** A command can reach the network, so what it can read it can send. Only the Off network level
    closes it, on a Mac, to all but this computer.
  - **Other local services.** On a Mac a command can still talk to other services on this computer, and to programs that
    listen on a local port. On Linux it can reach your session's bus and gpg agent under `/run/user`, and Docker's own port
    if you turned that on (on a Mac, ports 2375 and 2376 are refused).
  - **Other programs' environments, on a Mac.** A command can read the environment of your other programs, so keys you
    exported in a shell can be seen. Use squad-kit's sign-ins, not exported keys.
  - **An ssh agent.** A command cannot read a key loaded in it, but it can ask the agent to use it.
  - **What a command leaves running, on a Mac.** A process that leaves its group lives on after the command, with the same
    guard around it, and can change the copy's files.
  - **One story's downloads, in the next story.** A project's stories share one download folder, so only the first story
    downloads. So a story's code could change what a later story's commands use, in the same guard. It never reaches what
    you run yourself: your own checkout's setup after a merge, Your apps and the release pipeline use a download folder of
    their own that no story writes in, and your own caches stay read only.
- **The project's commit hooks run once, on a throwaway git folder.** squad-kit makes that folder outside the project for
  each run. It reads git's store of objects and writes only its own. Its settings are squad-kit's, with your branch by its
  real name and the repo's own filters, which run only in the guard. On Mac and Linux the real git folder stays read only to
  the hooks, all of it: objects, branches, settings, the stash and the hooks. Only two things come out: the files in the
  copy and the commit's words. squad-kit's own git then stages the files and makes the real commit, outside the guard, with
  your signature if your git signs. So nothing a hook puts in its git folder reaches the real store, and squad-kit's git
  never reads a setting a hook wrote. The folder goes after each run, and at the next start after a crash. A hook that
  reaches past it to the real folder can read there, and its writes are refused.
- **squad-kit runs no other hook.** Every other git it runs has hooks off: it does not run a project's `pre-push`,
  `post-merge`, `post-checkout` or `post-commit` outside that one commit (a `post-commit` runs on the throwaway folder). The
  project's own checks have already run in the guard by then. Pushing from your own terminal still runs your hooks.
  A project that uses Git LFS still gets its large files uploaded: a push runs squad-kit's own small `pre-push`, kept in
  its own folder, which does only that.
- **squad-kit's git starts nothing a repo names by itself:** no file monitor (`core.fsmonitor`), no diff program
  (`diff.external`, textconv), and it never looks inside a nested repo. Programs named in your own git settings for the
  network, credentials, filters and merges stay on (`core.sshCommand`, git-lfs): they need a line in a settings file,
  and neither the guard nor an agent's sandbox can write those files.
- **Windows has no guard and is not fully tested yet.** There, the agents' own commands and the project's own commands
  can reach other files on the computer, squad-kit's own too. Use it on projects you trust. Settings says so.
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
