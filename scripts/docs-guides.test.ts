import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { developerSidebar, guidesSidebar } from '../docs-site/.vitepress/sidebar';
import { REDIRECTS, redirectPage } from '../docs-site/.vitepress/redirects';

/**
 * Guard for the docs site's structure (DSK-254): the guide stays a short list
 * of whole pages, and no link into it breaks, including the old URLs of pages
 * that were merged away.
 *
 * VitePress fails a build on a link to a missing page, but it doesn't check
 * anchors, links in the theme's Vue files, or the redirects written at build
 * time. This test checks all three from the sources, so it runs with the main
 * suite and needs no docs build.
 */

const DOCS = join(process.cwd(), 'docs-site');

/** VitePress's heading slug (`@mdit-vue/shared` slugify), for headings without an explicit id. */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

/** The anchors a markdown page defines: explicit `{#id}`s and its headings' slugs. */
function anchorsOf(file: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[1] ?? '';
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(text);
    if (explicit?.[1]) {
      anchors.add(explicit[1]);
      continue;
    }
    const plain = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_]/g, '');
    anchors.add(slugify(plain));
  }
  return anchors;
}

/** The markdown file a route ("/guide/write", "/") is built from, or null. */
function pageFile(route: string): string | null {
  const clean = route.replace(/\.(md|html)$/, '').replace(/\/$/, '/index');
  const file = join(DOCS, `${clean === '' || clean === '/' ? '/index' : clean}.md`);
  return existsSync(file) ? file : null;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

/**
 * Internal links to pages: markdown links and raw `href`s in the docs, and
 * `withBase('…')`/`href="/…"` in the theme. Assets (images, downloads) and
 * external URLs are left out.
 */
function internalLinks(): Array<{ from: string; href: string }> {
  const links: Array<{ from: string; href: string }> = [];
  const isPageLink = (href: string): boolean => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('//')) return false;
    const path = href.split('#')[0] ?? '';
    return !/\.[a-z0-9]+$/i.test(path) || /\.(md|html)$/.test(path);
  };
  for (const file of markdownFiles(DOCS)) {
    let inFence = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) continue;
      for (const m of line.matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)) {
        const href = m[1] ?? m[2] ?? '';
        if (href && isPageLink(href)) links.push({ from: file, href });
      }
    }
  }
  const themeDir = join(DOCS, '.vitepress/theme');
  for (const name of readdirSync(themeDir).filter((n) => n.endsWith('.vue'))) {
    const file = join(themeDir, name);
    for (const m of readFileSync(file, 'utf8').matchAll(/withBase\('([^']+)'\)|href="(\/[^"]*)"/g)) {
      const href = m[1] ?? m[2] ?? '';
      if (href && isPageLink(href)) links.push({ from: file, href });
    }
  }
  return links;
}

/** Resolve a link to its page file and anchor; a relative link resolves from its file. */
function resolveLink(from: string, href: string): { file: string | null; anchor: string | null } {
  const [path = '', anchor = null] = href.split('#') as [string?, string?];
  if (path === '') return { file: from.endsWith('.md') ? from : null, anchor };
  const route = path.startsWith('/') ? path : `/${relative(DOCS, resolve(dirname(from), path))}`;
  return { file: pageFile(route), anchor };
}

describe('docs guide structure', () => {
  const guideLinks = guidesSidebar.flatMap((group) => group.items.map((item) => item.link));

  it('keeps the guide sidebar short enough to see at once', () => {
    // The founder's brief: condensed, easy to follow, not a sprawling tree.
    // Add a section to an existing page before adding a page.
    expect(guideLinks.length).toBeGreaterThanOrEqual(9);
    expect(guideLinks.length).toBeLessThanOrEqual(13);
  });

  it('links every sidebar entry to a page', () => {
    const all = [...guideLinks, ...developerSidebar.flatMap((group) => group.items.map((item) => item.link))];
    const missing = all.filter((link) => pageFile(link) === null);
    expect(missing).toEqual([]);
  });
});

describe('docs redirects', () => {
  const entries = Object.entries(REDIRECTS);

  it('has redirects for the merged pages', () => {
    expect(entries.length).toBeGreaterThanOrEqual(31);
  });

  it('never redirects an address that is a page again', () => {
    const live = entries.filter(([from]) => pageFile(from) !== null).map(([from]) => from);
    expect(live).toEqual([]);
  });

  it('points every redirect at a page and section that exist', () => {
    const broken = entries.filter(([, to]) => {
      const [page = '', anchor] = to.split('#');
      const file = pageFile(page);
      return file === null || (anchor !== undefined && !anchorsOf(file).has(anchor));
    });
    expect(broken).toEqual([]);
  });

  it('writes a page that sends the reader on, with a plain link as well', () => {
    const html = redirectPage('/guide/draw#connectors', 'https://docs.docushark.app');
    expect(html).toContain('url=/guide/draw.html#connectors');
    expect(html).toContain('location.replace("/guide/draw.html#connectors")');
    expect(html).toContain('<a href="/guide/draw.html#connectors">');
    expect(html).toContain('<link rel="canonical" href="https://docs.docushark.app/guide/draw.html">');
    expect(html).toContain('noindex');
  });
});

describe('docs links', () => {
  const links = internalLinks();

  it('finds the links it checks', () => {
    // Guards against a pattern change that silently matches nothing.
    expect(links.length).toBeGreaterThan(150);
  });

  it('links only to pages and sections that exist', () => {
    const broken = links
      .map(({ from, href }) => ({ from: relative(DOCS, from), href, ...resolveLink(from, href) }))
      .filter(({ file, anchor }) => file === null || (anchor !== null && !anchorsOf(file).has(anchor)))
      .map(({ from, href }) => `${from} → ${href}`);
    expect(broken).toEqual([]);
  });
});
