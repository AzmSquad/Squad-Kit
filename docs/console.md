# Squad console

## What is `squad console`?

`squad console` starts a **local-only** web UI that mirrors the squad-kit CLI: same `.squad/` files, same config and secrets, no separate database. From your project root run `squad console` (default port **4571**). The CLI prints a URL with a one-time session token; your browser stores the token in `sessionStorage`. Use **`--no-open`** to skip launching a browser if you prefer to paste the URL yourself.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open command palette | ⌘K / Ctrl+K |
| Show this cheatsheet | ? |
| Dashboard | g d |
| Stories | g s |
| Plans | g p |
| Generate plan | g r |
| Config | g c |
| Secrets | g k |
| Tracker | g t |
| Doctor | g h |
| New story | n s |
| Close any dialog | Esc |

## Density

Use the top bar **Comfortable** / **Compact** control to change list spacing and type scale. The choice is stored in `localStorage` and applies on the next page load.

## Security model

- **Loopback binding** — the server listens on `127.0.0.1` only; it is not exposed to your LAN by default.
- **Token-gated API** — every `/api/*` request requires the `Bearer` token (or `?t=` query) from the launch URL; without it you get `401`.
- **Secrets** — the Secrets page masks values; YAML is edited through the same validation paths as the CLI.
- **CSP** — responses use tight Content-Security-Policy headers suitable for the bundled SPA.

## Dashboard

Three summary cards (**Project**, **Planner**, **Last cache hit**) match the top-of-workspace snapshot. Below them, when you have run history:

- **Cache hit ratio** — ring chart from the latest `.squad/.last-run.json` telemetry.
- **Token spend** — sparkline of `inputTokens + outputTokens` over the last 20 runs (from `.squad/runs/*.json`).
- **Run duration** — bar chart of recent run lengths in seconds.

![Dashboard — dark, flat console with sectioned sidebar](images/console/dashboard.png)

## Stories

List by feature, create from the **New story** dialog, edit intake markdown, delete (trash or permanent). Same folders the CLI would create.

![New story dialog — dark, flat console with sectioned sidebar](images/console/stories-new.png)

## Plans

Browse plans per feature, open a markdown viewer, compare any two plan files in a feature with a readable diff, delete when needed.

![Plan diff — dark, flat console with sectioned sidebar](images/console/plan-diff.png)

## Generate plan

Pick a story and start an API planning run. The UI subscribes to **SSE** and shows streaming tool use, assistant text, cache ratio, and rate-limit waits. Cancel aborts cleanly and can leave a `*.partial.md` on disk, same as the CLI.

**Copy mode** on the same page loads the composed `generate-plan.md` + intake meta-prompt (identical to `squad new-plan --copy`), shows a scrollable preview, and offers a **Copy full prompt** button with step-by-step paste instructions — no terminal required.

![Generate streaming — dark, flat console with sectioned sidebar](images/console/generate.png)

## Config, Secrets, Tracker, Doctor

- **Config** — form + YAML views; save runs the same schema validation as `squad config`.
- **Secrets** — masked fields; **Test connection** reuses the doctor probes.
- **Tracker** — search Jira / Azure and import an issue as a story.
- **Doctor** — graphical PASS / WARN / FAIL with expandable detail; apply non-destructive fixes when offered.

![Doctor — dark, flat console with sectioned sidebar](images/console/doctor.png)

## Multi-project

The top bar lists **recent project roots** from `~/.squad/recent-projects.json`. Each console process serves **one** workspace. Opening another project in the same tab is not supported; choose a recent root and the UI copies `cd <that-root> && squad console` so you can run it in a second terminal. Full multi-server federation is out of scope for v1.

## Development setup

For Vite hot reload against a running `squad console`, see [`console-ui/README.md`](../console-ui/README.md).

## Troubleshooting

| Issue | What to do |
| --- | --- |
| Port already in use | Run `squad console --port <n>` or stop the other process on 4571. |
| Session token missing or invalid | Close the tab and relaunch `squad console` from the project; use the fresh URL. |
| Charts show “no runs yet” | Run **Generate** (or `squad new-plan --api`) once so `.squad/runs/` is populated. |
