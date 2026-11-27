/**
 * Old docs URLs that keep working after their pages were merged (DSK-254).
 *
 * The site is static (GitHub Pages, and the copy bundled into the desktop app),
 * so a redirect is a small HTML page written at the old address by `buildEnd`.
 * It sends the reader to the new page and section, tells search engines where
 * the page lives now, and still offers a plain link without JavaScript.
 *
 * Keep the targets' anchors as explicit heading ids (`## Connectors {#connectors}`)
 * so rewording a heading can't break a redirect. scripts/docs-guides.test.ts
 * checks that every target page and anchor exists and that no old address is
 * still a page.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Old route (no extension) → the new route, with the section's anchor. */
export const REDIRECTS: Record<string, string> = {
  // Start here
  '/getting-started/introduction': '/guide/start-here',
  '/getting-started/installation': '/guide/start-here#get-docushark',
  '/getting-started/quick-start': '/guide/start-here#first-document',
  '/getting-started/interface-tour': '/guide/start-here#find-your-way-around',
  '/guide/concepts': '/guide/start-here#how-it-fits-together',
  // Write
  '/guide/rich-text-editor': '/guide/write',
  '/guide/citations': '/guide/write#citations',
  '/guide/document-fields': '/guide/write#fields',
  '/guide/embedded-files': '/guide/write#files',
  // Draw
  '/guide/canvas-navigation': '/guide/draw#move-around',
  '/guide/drawing-tools': '/guide/draw#tools',
  '/guide/connectors': '/guide/draw#connectors',
  '/guide/shape-libraries': '/guide/draw#shape-libraries',
  '/guide/uml-and-erd': '/guide/draw#uml-and-erd',
  '/guide/sequence-diagrams': '/guide/draw#sequence-diagrams',
  '/guide/whiteboard': '/guide/draw#whiteboard',
  // Organize
  '/guide/multi-page-documents': '/guide/organize#pages',
  '/guide/collections': '/guide/organize#collections-and-tags',
  '/guide/recovery-and-undo': '/guide/organize#history-and-trash',
  '/guide/offline-and-sync': '/guide/organize#offline',
  // Share and collaborate
  '/guide/collaboration': '/guide/share',
  '/guide/sharing-and-access': '/guide/share#share-a-document',
  '/guide/connect-your-agent': '/guide/share#connect-an-ai-agent',
  // Make it yours
  '/guide/appearance': '/guide/make-it-yours#appearance',
  '/guide/styling': '/guide/make-it-yours#style-profiles',
  '/guide/layout-modes': '/guide/make-it-yours#layouts',
  '/guide/settings': '/guide/make-it-yours#settings',
  '/guide/mobile-preview': '/guide/make-it-yours#phone',
  // Tutorials folded into the gallery
  '/tutorials/course-curriculum': '/tutorials/examples#course-curriculum',
  '/tutorials/content-creator': '/tutorials/examples#content-plan',
  '/tutorials/aws-architecture-diagram': '/tutorials/examples#aws-architecture',
}

/** The served address of a route: pages are `<route>.html` (cleanUrls is off). */
export function servedPath(route: string): string {
  const [page, anchor] = route.split('#')
  return `${page}.html${anchor ? `#${anchor}` : ''}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The page written at an old address. */
export function redirectPage(target: string, hostname: string): string {
  const href = escapeHtml(servedPath(target))
  const canonical = escapeHtml(`${hostname}${servedPath(target.split('#')[0] ?? target)}`)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>This page has moved · DocuShark Docs</title>',
    '<meta name="robots" content="noindex">',
    `<link rel="canonical" href="${canonical}">`,
    `<meta http-equiv="refresh" content="0; url=${href}">`,
    `<script>location.replace(${JSON.stringify(servedPath(target))})</script>`,
    '</head>',
    `<body><p>This page has moved to <a href="${href}">${href}</a>.</p></body>`,
    '</html>',
    '',
  ].join('\n')
}

/** Write a redirect page at every old address in the built site. */
export function writeRedirects(outDir: string, hostname: string): void {
  for (const [from, to] of Object.entries(REDIRECTS)) {
    const file = path.join(outDir, `${from}.html`)
    // An old address that's a page again must lose its redirect, not overwrite the page.
    if (fs.existsSync(file)) {
      throw new Error(`docs redirect ${from} would overwrite a built page; remove it from REDIRECTS`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, redirectPage(to, hostname))
  }
}
