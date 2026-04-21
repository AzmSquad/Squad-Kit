# squad-kit website

The public landing page + documentation for [squad-kit](https://www.npmjs.com/package/squad-kit).

Built with **Astro 5 + Tailwind CSS v4**. Ships essentially zero JavaScript — the entire site is static HTML with small, inline interactivity where needed.

## Local dev

```bash
cd site
npm install
npm run dev         # http://localhost:4321
```

## Build

```bash
npm run build       # → dist/
npm run preview     # preview the built output
npm run check       # astro type-check
```

## Project layout

```
site/
├── astro.config.mjs
├── netlify.toml
├── public/                 # static assets (favicon, og image)
├── src/
│   ├── components/         # Hero, ThreeSteps, Comparison, Install, …
│   ├── content.config.ts   # content collection loading ../docs/*.md
│   ├── layouts/
│   │   ├── Layout.astro    # base (nav, footer, SEO, fonts)
│   │   └── DocsLayout.astro
│   ├── pages/
│   │   ├── index.astro     # landing
│   │   ├── 404.astro
│   │   └── docs/
│   │       └── [...slug].astro
│   └── styles/global.css   # Tailwind v4 + theme tokens
└── dist/                   # build output (gitignored)
```

The docs pages are rendered **directly from `../docs/*.md`** via Astro's content
collection `glob` loader. Edit the canonical Markdown in the repo's top-level
`docs/` folder and the site picks it up on next build.

## Deploying to Netlify

The repo ships with `netlify.toml` pre-configured:

```toml
[build]
  base = "site"
  command = "npm run build"
  publish = "dist"
```

### First-time setup

1. Push the repo to GitHub (already done).
2. On Netlify: **Add new site → Import from Git → pick `AzmSquad/Squad-Kit`**.
3. Netlify auto-detects the `netlify.toml`; confirm and deploy.
4. (Optional) Set a custom domain under **Site settings → Domain management**.

After the first deploy, every push to `main` that touches `site/` or `docs/`
triggers a redeploy automatically.

## Customizing

- **Colors / theme:** edit the CSS variables in `src/styles/global.css` under `@theme`.
- **Landing copy:** edit the component files under `src/components/`.
- **Docs content:** edit the Markdown in `../docs/` (the repo root `docs/` folder).
- **SEO:** edit `src/layouts/Layout.astro` for default title, description, og image.

## License

MIT — same as squad-kit itself.
