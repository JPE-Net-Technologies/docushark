import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const isGitHubPages = process.env['GITHUB_PAGES'] === 'true'

export default withMermaid(
  defineConfig({
    title: 'DocuShark',
    description: 'DocuShark — high-performance diagramming and whiteboard application',
    base: isGitHubPages ? '/docushark/' : '/',

    head: [
      ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: 'DocuShark — High-Performance Diagramming' }],
      ['meta', { property: 'og:description', content: 'Create stunning diagrams with 10,000+ shapes at 60fps. Real-time collaboration. Desktop & web.' }],
      ['meta', { property: 'og:image', content: 'https://jpe-net-technologies.github.io/docushark/DocuShark.png' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: 'DocuShark — High-Performance Diagramming' }],
      ['meta', { name: 'twitter:description', content: 'Create stunning diagrams with 10,000+ shapes at 60fps. Real-time collaboration. Desktop & web.' }],
      ['meta', { name: 'twitter:image', content: 'https://jpe-net-technologies.github.io/docushark/DocuShark.png' }],
    ],

    themeConfig: {
      logo: { src: '/DocuShark.svg', alt: 'DocuShark' },

      nav: [
        { text: 'Getting Started', link: '/getting-started/introduction' },
        { text: 'Guide', link: '/guide/canvas-navigation' },
        { text: 'Developer', link: '/developer/architecture' },
      ],

      sidebar: {
        '/getting-started/': [
          {
            text: 'Getting Started',
            items: [
              { text: 'Introduction', link: '/getting-started/introduction' },
              { text: 'Installation', link: '/getting-started/installation' },
              { text: 'Quick Start', link: '/getting-started/quick-start' },
              { text: 'Interface Tour', link: '/getting-started/interface-tour' },
            ],
          },
        ],
        '/guide/': [
          {
            text: 'User Guide',
            items: [
              { text: 'Canvas & Navigation', link: '/guide/canvas-navigation' },
              { text: 'Drawing Tools', link: '/guide/drawing-tools' },
              { text: 'Connectors', link: '/guide/connectors' },
              { text: 'Shape Libraries', link: '/guide/shape-libraries' },
              { text: 'Styling & Themes', link: '/guide/styling' },
              { text: 'Multi-Page Documents', link: '/guide/multi-page-documents' },
              { text: 'Rich Text & Notes', link: '/guide/rich-text-editor' },
              { text: 'Embedded Files', link: '/guide/embedded-files' },
              { text: 'Export & Import', link: '/guide/export-import' },
              { text: 'Whiteboard & Ideas', link: '/guide/whiteboard' },
              { text: 'Collaboration', link: '/guide/collaboration' },
              { text: 'Keyboard Shortcuts', link: '/guide/keyboard-shortcuts' },
              { text: 'Settings', link: '/guide/settings' },
            ],
          },
        ],
        '/developer/': [
          {
            text: 'Developer Guide',
            items: [
              { text: 'Architecture Overview', link: '/developer/architecture' },
              { text: 'Project Setup', link: '/developer/project-setup' },
              { text: 'Core Systems', link: '/developer/core-systems' },
              { text: 'State Management', link: '/developer/state-management' },
              { text: 'Creating Custom Shapes', link: '/developer/creating-shapes' },
              { text: 'Creating Custom Tools', link: '/developer/creating-tools' },
              { text: 'Shape Properties', link: '/developer/shape-properties' },
              { text: 'Plugin Development', link: '/developer/plugin-development' },
              { text: 'Collaboration Protocol', link: '/developer/collaboration-protocol' },
              { text: 'Utility Modules', link: '/developer/utilities' },
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
        message: 'Released under the MIT License.',
        copyright: 'Copyright © 2024-present DocuShark Contributors',
      },
    },
  })
)
