import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { rehypeDocLinks } from './src/plugins/rehype-doc-links.mjs';

export default defineConfig({
  site: 'https://squad-kit.com',
  // Keep the whitespace between inline elements (the Astro 7 default, 'jsx', strips it).
  compressHTML: true,
  integrations: [mdx(), sitemap()],
  redirects: {
    '/docs': '/docs/getting-started',
  },
  vite: {
    plugins: [tailwindcss()],
    // Astro builds for `esnext`, so Vite's CSS minifier would drop the -webkit- prefixes that
    // older Safari still needs (for example on the nav's backdrop blur). Keep Vite's browser list.
    build: {
      cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'],
    },
  },
  markdown: {
    // Docs are authored for GitHub, where `[x](customization.md)` is correct. Rewrite those to
    // `/docs/customization` so the same file reads correctly in both places.
    processor: unified({ rehypePlugins: [rehypeDocLinks] }),
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: true,
    },
  },
});
