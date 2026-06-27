import fs from 'node:fs'
import path from 'node:path'

// Minimal build-time generator for /llms.txt and /llms-full.txt, following the
// llmstxt.org convention. Runs from VitePress's `buildEnd` hook, so the files
// land in the build output (dist) on every build — including `build:offline`.
//
// We deliberately avoid extra deps: frontmatter is parsed with a small reader
// (the docs use only single-line `title:` / `description:` keys), and page
// order + grouping is passed in from config.mts so the output mirrors the
// sidebar IA without a parallel table.

export interface LlmsItem {
  text: string
  link: string
}

export interface LlmsSection {
  title: string
  items: LlmsItem[]
}

export interface LlmsOptions {
  hostname: string
  siteTitle: string
  siteDescription: string
  sections: LlmsSection[]
}

// Subset of VitePress's SiteConfig that we actually need.
interface BuildConfig {
  srcDir: string
  outDir: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(FRONTMATTER_RE)
  if (!match || match[1] === undefined) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (kv && kv[1] !== undefined && kv[2] !== undefined) {
      data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { data, body: raw.slice(match[0].length) }
}

function firstHeading(body: string): string {
  const m = body.match(/^#\s+(.+)$/m)
  return m && m[1] !== undefined ? m[1].trim() : ''
}

// Resolve a sidebar link ("/guide/connectors") to its source markdown file.
function sourcePath(srcDir: string, link: string): string {
  const rel = link.replace(/^\/+/, '').replace(/\/$/, '')
  const candidate = rel === '' ? 'index.md' : `${rel}.md`
  return path.join(srcDir, candidate)
}

function readPage(
  srcDir: string,
  item: LlmsItem,
): { title: string; description: string; body: string } | null {
  const file = sourcePath(srcDir, item.link)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(raw)
  return {
    title: data['title'] || firstHeading(body) || item.text,
    description: data['description'] || '',
    body: body.trim(),
  }
}

function absoluteUrl(hostname: string, link: string): string {
  const clean = link.replace(/\/$/, '')
  return clean === '' ? `${hostname}/` : `${hostname}${clean}`
}

export function generateLlmsTxt(config: BuildConfig, opts: LlmsOptions): void {
  const { srcDir, outDir } = config
  const { hostname, siteTitle, siteDescription, sections } = opts

  // ---- /llms.txt — curated index ----
  const indexLines: string[] = [
    `# ${siteTitle}`,
    '',
    `> ${siteDescription}`,
    '',
    'This file helps language models navigate the DocuShark documentation. For the full text of every page in a single file, see [/llms-full.txt](' +
      `${hostname}/llms-full.txt).`,
    '',
  ]

  // ---- /llms-full.txt — full page contents ----
  const fullLines: string[] = [
    `# ${siteTitle} — Full Documentation`,
    '',
    `> ${siteDescription}`,
    '',
    `Source: ${hostname}/`,
    '',
  ]

  for (const section of sections) {
    indexLines.push(`## ${section.title}`, '')
    for (const item of section.items) {
      const page = readPage(srcDir, item)
      if (!page) continue
      const url = absoluteUrl(hostname, item.link)
      const suffix = page.description ? `: ${page.description}` : ''
      indexLines.push(`- [${page.title}](${url})${suffix}`)

      fullLines.push('---', '', `# ${page.title}`, '', `Source: ${url}`, '')
      if (page.description) fullLines.push(`> ${page.description}`, '')
      fullLines.push(page.body, '')
    }
    indexLines.push('')
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'llms.txt'), indexLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  fs.writeFileSync(path.join(outDir, 'llms-full.txt'), fullLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
}
