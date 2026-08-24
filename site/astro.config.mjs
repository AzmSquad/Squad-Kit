import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { rehypeDocLinks } from './src/plugins/rehype-doc-links.mjs';

export default defineConfig({
  site: 'https://squad-kit.com',
  integrations: [mdx(), sitemap()],
  redirects: {
    '/docs': '/docs/getting-started',
  },
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // Docs are authored for GitHub, where `[x](customization.md)` is correct. Rewrite those to
    // `/docs/customization` so the same file reads correctly in both places.
    rehypePlugins: [rehypeDocLinks],
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: true,
    },
  },
});
