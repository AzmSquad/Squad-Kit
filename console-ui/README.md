# squad console UI

Vite + React SPA for `squad console`, bundled into `dist/console-ui/` at the package root.

## Local development (HMR + API proxy)

1. **Terminal A:** from the `squad-kit` package root, run `pnpm dev` (CLI watcher) if you are changing the server.
2. **Terminal B:** in a squad-kit-initialised project directory, run `node /path/to/squad-kit/dist/cli.js console --no-open`. Note the printed URL and token.
3. **Terminal C:** from the `squad-kit` package root, run `pnpm -C console-ui dev` — Vite serves on `http://127.0.0.1:5173` and proxies `/api/*` and `/healthz` to the running console (default `http://127.0.0.1:4571`).
4. Open `http://127.0.0.1:5173/?t=<token>` so the SPA can authenticate; the `?t=` query is stripped after bootstrap.

## Build

From the `squad-kit` package root, `pnpm build` runs the SPA build then `tsup`. The UI output lives at `dist/console-ui/`.
