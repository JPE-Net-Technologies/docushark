import { defineConfig, type HeadConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { generateLlmsTxt } from './plugins/llms'
import { developerSidebar, guidesSidebar } from './sidebar'
import { writeRedirects } from './redirects'

const SITE_TITLE = 'DocuShark Docs'
const SITE_DESCRIPTION =
  'Guides and developer references for DocuShark — writing, diagrams and files in one document.'

// Canonical host for the published docs (GitHub Pages, apex CNAME). Used for
// canonical/og:url tags and JSON-LD. SiteData has no `url` field, so we keep
// the hostname here as the single source of truth.
const HOSTNAME = 'https://docs.docushark.app'

// `transformHead` receives the source markdown path (e.g. "guide/connectors.md",
// "index.md"). We derive two things from it:
//
//  - canonicalUrl: the absolute URL matching what VitePress emits in the sitemap
//    and internal links. With cleanUrls off (the default here), interior pages
//    are served at "<path>.html" and the home page at "/".
//  - routeKey: an extensionless, slash-prefixed key ("/guide/connectors") used
//    to match sidebar `link` values when resolving the breadcrumb trail.
function canonicalUrlOf(page: string): string {
  if (page === 'index.md') return `${HOSTNAME}/`
  const nested = page.match(/^(.*)\/index\.md$/)
  if (nested) return `${HOSTNAME}/${nested[1]}/`
  return `${HOSTNAME}/${page.replace(/\.md$/, '.html')}`
}

function routeKeyOf(page: string): string {
  if (page === 'index.md') return '/'
  const nested = page.match(/^(.*)\/index\.md$/)
  if (nested) return `/${nested[1]}`
  return `/${page.replace(/\.md$/, '')}`
}

// Convert a sidebar link ("/guide/start-here") to its canonical
// absolute URL, matching the sitemap's ".html" form so breadcrumb ancestor
// items stay consistent with the leaf's canonical URL.
function linkToUrl(link: string): string {
  const clean = link.replace(/^\/+/, '').replace(/\/$/, '')
  return clean === '' ? `${HOSTNAME}/` : `${HOSTNAME}/${clean}.html`
}

// Resolve a route to its breadcrumb trail (area + group + title) from the
// sidebar definitions, so the JSON-LD BreadcrumbList mirrors the visual one.
function resolveBreadcrumb(
  route: string,
  pageTitle: string,
): { areaLabel: string; areaLink: string; group: string; title: string } | null {
  let area: { label: string; link: string; sidebar: typeof guidesSidebar } | null = null
  if (route.startsWith('/developer/')) {
    area = { label: 'Build', link: '/developer/architecture', sidebar: developerSidebar }
  } else if (route.startsWith('/guide/') || route.startsWith('/tutorials/')) {
    area = { label: 'Guides', link: '/guide/start-here', sidebar: guidesSidebar }
  }
  if (!area) return null

  for (const grp of area.sidebar) {
    for (const item of grp.items) {
      if (item.link === route) {
        // A group named like its area ("Guides" in Guides) would only repeat it.
        const group = grp.text === area.label ? '' : grp.text
        return { areaLabel: area.label, areaLink: area.link, group, title: item.text }
      }
    }
  }
  // Page not found in sidebar (shouldn't happen) — still emit a 2-level trail.
  return { areaLabel: area.label, areaLink: area.link, group: '', title: pageTitle }
}

export default withMermaid(
  defineConfig({
    title: 'DocuShark',
    description: 'DocuShark — writing, diagrams and files in one document',
    // Served from the apex domain docs.docushark.app, so assets are root-relative.
    // (Was '/docushark/' for the old github.io project-path host — JP-314.)
    base: '/',

    head: [
      ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
      ['meta', { property: 'og:site_name', content: 'DocuShark' }],
      ['meta', { property: 'og:locale', content: 'en_US' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: 'DocuShark Docs' }],
      ['meta', { property: 'og:description', content: 'Guides and developer references for DocuShark — writing, diagrams and files in one document.' }],
      ['meta', { property: 'og:image', content: 'https://docs.docushark.app/docushark-badge.png' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: 'DocuShark Docs' }],
      ['meta', { name: 'twitter:description', content: 'Guides and developer references for DocuShark — writing, diagrams and files in one document.' }],
      ['meta', { name: 'twitter:image', content: 'https://docs.docushark.app/docushark-badge.png' }],
    ],

    // Native VitePress sitemap — no extra dep. See node_modules/vitepress SitemapOptions.
    sitemap: {
      hostname: HOSTNAME,
    },

    // Emit /llms.txt + /llms-full.txt into the build output. Runs for both
    // `build` and `build:offline`, so a local `preview` serves them too.
    // Sections mirror the sidebar IA defined above.
    buildEnd(siteConfig) {
      generateLlmsTxt(siteConfig, {
        hostname: HOSTNAME,
        siteTitle: SITE_TITLE,
        siteDescription: SITE_DESCRIPTION,
        sections: [
          ...guidesSidebar.map((g) => ({ title: g.text, items: g.items })),
          { title: 'Build', items: developerSidebar.flatMap((g) => g.items) },
        ],
      })
      // Pages that were merged or renamed (DSK-254) answer at their old URLs.
      writeRedirects(siteConfig.outDir, HOSTNAME)
    },

    // Per-page <head> augmentation, emitted into the static HTML at build time:
    //  - canonical + og:url/twitter:url derived from the resolved route
    //  - JSON-LD: WebSite + SearchAction on the home page, BreadcrumbList on
    //    interior pages (mirrors the visual breadcrumb)
    // VitePress already injects per-page title/description from frontmatter.
    transformHead({ page, pageData }) {
      const routeKey = routeKeyOf(page)
      const url = canonicalUrlOf(page)

      const head: HeadConfig[] = [
        ['link', { rel: 'canonical', href: url }],
        ['meta', { property: 'og:url', content: url }],
        ['meta', { name: 'twitter:url', content: url }],
      ]

      if (routeKey === '/') {
        head.push([
          'script',
          { type: 'application/ld+json' },
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'DocuShark Docs',
            url: `${HOSTNAME}/`,
            description:
              'Guides and developer references for DocuShark — writing, diagrams and files in one document.',
            publisher: {
              '@type': 'Organization',
              name: 'JPE-Net Technologies',
              url: 'https://github.com/JPE-Net-Technologies/docushark',
            },
            potentialAction: {
              '@type': 'SearchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: `${HOSTNAME}/?q={search_term_string}`,
              },
              'query-input': 'required name=search_term_string',
            },
          }),
        ])
      } else {
        const crumb = resolveBreadcrumb(routeKey, pageData.title)
        if (crumb) {
          const items: Array<Record<string, unknown>> = [
            { '@type': 'ListItem', position: 1, name: 'Docs', item: `${HOSTNAME}/` },
            {
              '@type': 'ListItem',
              position: 2,
              name: crumb.areaLabel,
              item: linkToUrl(crumb.areaLink),
            },
          ]
          let pos = 3
          if (crumb.group) {
            items.push({ '@type': 'ListItem', position: pos++, name: crumb.group })
          }
          items.push({ '@type': 'ListItem', position: pos, name: crumb.title, item: url })
          head.push([
            'script',
            { type: 'application/ld+json' },
            JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'BreadcrumbList',
              itemListElement: items,
            }),
          ])
        }
      }

      return head
    },

    themeConfig: {
      logo: { src: '/docushark-logo.png', alt: 'DocuShark' },

      nav: [
        { text: 'Home', link: '/' },
        { text: 'Guides', link: '/guide/start-here', activeMatch: '/guide/|/tutorials/' },
        { text: 'Build', link: '/developer/architecture', activeMatch: '/developer/' },
        { text: 'Website', link: 'https://docushark.app' },
        { text: 'Open DocuShark', link: 'https://app.docushark.app' },
      ],

      sidebar: {
        '/guide/': guidesSidebar,
        '/tutorials/': guidesSidebar,
        '/developer/': developerSidebar,
      },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/JPE-Net-Technologies/docushark' },
      ],

      search: {
        provider: 'local',
      },

      footer: {
        message: 'Released under the AGPL-3.0 License.',
        copyright: 'Copyright © 2024-present JPE-Net Technologies',
      },
    },
  })
)
