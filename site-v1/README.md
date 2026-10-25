# squad-kit v1 website

The coming-soon site for squad-kit v1, served at [v1.squad-kit.com](https://v1.squad-kit.com).

A single static page with no build step. Everything the browser loads lives in `public/`.

## Local preview

```bash
cd site-v1/public
python3 -m http.server 4599   # http://localhost:4599
```

## Deploy

Hosted on Cloudflare Workers (static assets). `wrangler.jsonc` binds the custom domain
`v1.squad-kit.com`; the first deploy creates its DNS record and certificate in the
`squad-kit.com` zone.

```bash
cd site-v1
npx wrangler@4.149.0 login    # once per machine
npx wrangler@4.149.0 deploy
```

## Layout

```
site-v1/
├── wrangler.jsonc       # Worker name, assets folder, custom domain
└── public/
    ├── index.html       # the whole page: markup, styles, board animation
    ├── 404.html
    ├── _headers         # security headers
    ├── og.png           # link preview image (1200×630)
    ├── logo.svg, logo-wordmark.svg, favicon.svg
    ├── favicon-32.png, apple-touch-icon.png, icon-512.png
    ├── robots.txt
    └── sitemap.xml
```
