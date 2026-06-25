import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// The Guides area spans two folders: /getting-started/ (the onboarding group)
// and /guide/ (the using-DocuShark group). Both routes share one sidebar.
const guidesSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/getting-started/introduction' },
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Quick Start', link: '/getting-started/quick-start' },
      { text: 'Interface Tour', link: '/getting-started/interface-tour' },
    ],
  },
  {
    text: 'Using DocuShark',
    items: [
      { text: 'Canvas & Navigation', link: '/guide/canvas-navigation' },
      { text: 'Layout Modes', link: '/guide/layout-modes' },
      { text: 'Drawing Tools', link: '/guide/drawing-tools' },
      { text: 'Connectors', link: '/guide/connectors' },
      { text: 'Shape Libraries', link: '/guide/shape-libraries' },
      { text: 'Styling & Themes', link: '/guide/styling' },
      { text: 'Multi-Page Documents', link: '/guide/multi-page-documents' },
      { text: 'Rich Text & Notes', link: '/guide/rich-text-editor' },
      { text: 'Citations & References', link: '/guide/citations' },
      { text: 'Document Fields', link: '/guide/document-fields' },
      { text: 'Embedded Files', link: '/guide/embedded-files' },
      { text: 'Collections', link: '/guide/collections' },
      { text: 'Export & Import', link: '/guide/export-import' },
      { text: 'Whiteboard & Ideas', link: '/guide/whiteboard' },
      { text: 'Collaboration', link: '/guide/collaboration' },
      { text: 'Connect an AI Agent', link: '/guide/connect-your-agent' },
      { text: 'Keyboard Shortcuts', link: '/guide/keyboard-shortcuts' },
      { text: 'Settings', link: '/guide/settings' },
    ],
  },
]

export default withMermaid(
  defineConfig({
    title: 'DocuShark',
    description: 'DocuShark — diagramming and docs in one offline-first editor',
    // Served from the apex domain docs.docushark.app, so assets are root-relative.
    // (Was '/docushark/' for the old github.io project-path host — JP-314.)
    base: '/',

    head: [
      ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: 'DocuShark Docs' }],
      ['meta', { property: 'og:description', content: 'Guides and developer references for DocuShark — diagramming and docs in one offline-first editor.' }],
      ['meta', { property: 'og:image', content: 'https://docs.docushark.app/docushark-badge.png' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: 'DocuShark Docs' }],
      ['meta', { name: 'twitter:description', content: 'Guides and developer references for DocuShark — diagramming and docs in one offline-first editor.' }],
      ['meta', { name: 'twitter:image', content: 'https://docs.docushark.app/docushark-badge.png' }],
    ],

    themeConfig: {
      logo: { src: '/docushark-logo.png', alt: 'DocuShark' },

      nav: [
        { text: 'Home', link: '/' },
        { text: 'Guides', link: '/getting-started/introduction', activeMatch: '/getting-started/|/guide/' },
        { text: 'Developer', link: '/developer/architecture', activeMatch: '/developer/' },
        { text: 'Open DocuShark', link: 'https://app.docushark.app' },
      ],

      sidebar: {
        '/getting-started/': guidesSidebar,
        '/guide/': guidesSidebar,
        '/developer/': [
          {
            text: 'Getting Set Up',
            items: [
              { text: 'Architecture Overview', link: '/developer/architecture' },
              { text: 'Project Setup', link: '/developer/project-setup' },
              { text: 'Core Systems', link: '/developer/core-systems' },
              { text: 'State Management', link: '/developer/state-management' },
            ],
          },
          {
            text: 'Extending DocuShark',
            items: [
              { text: 'Creating Custom Shapes', link: '/developer/creating-shapes' },
              { text: 'Creating Custom Tools', link: '/developer/creating-tools' },
              { text: 'Creating Prose Helpers', link: '/developer/creating-prose-helpers' },
              { text: 'Shape Properties', link: '/developer/shape-properties' },
              { text: 'Plugin Development', link: '/developer/plugin-development' },
              { text: 'Collaboration Protocol', link: '/developer/collaboration-protocol' },
              { text: 'Utility Modules', link: '/developer/utilities' },
              { text: 'AI Agents (MCP) & Recipes', link: '/developer/mcp-agent-recipes' },
            ],
          },
          {
            text: 'Contributing',
            items: [
              { text: 'Contributing', link: '/developer/contributing' },
              { text: 'Roadmap', link: '/developer/roadmap' },
            ],
          },
        ],
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
