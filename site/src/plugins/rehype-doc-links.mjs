/**
 * Rewrite relative `*.md` links inside the docs collection to their site routes.
 *
 * The Markdown under `project/docs/` is read in two places: on GitHub / in the npm repo, where
 * `[customization.md](customization.md)` is the correct link, and on this site, where the same
 * href resolves against `/docs/<slug>/` and 404s. Rather than making the repo copy site-shaped
 * (which would break the GitHub reading), the site rewrites at build time.
 *
 * `getting-started.md#section` → `/docs/getting-started#section`. Absolute URLs, anchors, mailto,
 * and non-`.md` targets are left alone. Hand-rolled walk so the plugin needs no extra dependency.
 */
const RELATIVE_MD = /^(?!\w+:|\/\/|#)([^?#]+?)\.md(#.*)?$/;

function rewrite(href) {
  const match = RELATIVE_MD.exec(href);
  if (!match) return href;
  // Strip any leading `./` and drop directory traversal we do not support (docs/ is flat).
  const slug = match[1].replace(/^\.\//, '');
  if (slug.includes('/')) return href;
  return `/docs/${slug}${match[2] ?? ''}`;
}

function walk(node) {
  if (node.type === 'element' && node.tagName === 'a') {
    const href = node.properties?.href;
    if (typeof href === 'string') node.properties.href = rewrite(href);
  }
  for (const child of node.children ?? []) walk(child);
}

export function rehypeDocLinks() {
  return (tree) => walk(tree);
}

export default rehypeDocLinks;
