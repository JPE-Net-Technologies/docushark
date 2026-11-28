/**
 * The docs sidebars, kept free of imports so a plain Node test can read them
 * (scripts/docs-guides.test.ts) without VitePress installed.
 */

// The Guides area: one page per job, each readable top to bottom (DSK-254),
// then the tutorials. The whole sidebar fits on one screen; keep it that way.
// A page that's merged away or renamed keeps working through a redirect in
// ./redirects.ts, and scripts/docs-guides.test.ts checks both.
export const guidesSidebar = [
  {
    text: 'Guides',
    items: [
      { text: 'Start here', link: '/guide/start-here' },
      { text: 'Start with what you do', link: '/guide/start-with-what-you-do' },
      { text: 'Write', link: '/guide/write' },
      { text: 'Draw', link: '/guide/draw' },
      { text: 'Organize', link: '/guide/organize' },
      { text: 'Share and collaborate', link: '/guide/share' },
      { text: 'Make it yours', link: '/guide/make-it-yours' },
      { text: 'Export and import', link: '/guide/export-import' },
      { text: 'Keyboard shortcuts', link: '/guide/keyboard-shortcuts' },
    ],
  },
  {
    text: 'Tutorials',
    items: [
      { text: 'A research notebook', link: '/tutorials/research-project' },
      { text: 'A design doc with a diagram', link: '/tutorials/design-doc-with-diagram' },
      { text: 'Example gallery', link: '/tutorials/examples' },
    ],
  },
]

// The Build area (customer-facing label "Build"; routes stay under /developer/).
// Scoped to the two jobs we want OSS devs doing: Extend (shapes/tools/UI/plugins)
// and Integrate (REST/MCP consumption, hand-rolled clients). The engine core +
// relay CRDT/sync internals are readable AGPL but not a documented extension
// surface — see the "extension surface vs engine core" note in architecture.md.
export const developerSidebar = [
  {
    text: 'Get Set Up',
    items: [
      { text: 'How the Engine Fits Together', link: '/developer/architecture' },
      { text: 'Project Setup', link: '/developer/project-setup' },
      { text: 'Contributing', link: '/developer/contributing' },
      // Not officially supported yet — see the page's own warning banner.
      { text: 'Self-Hosting (Future)', link: '/developer/self-hosting' },
    ],
  },
  {
    text: 'Extend DocuShark',
    items: [
      { text: 'Creating Custom Shapes', link: '/developer/creating-shapes' },
      { text: 'Shape Properties', link: '/developer/shape-properties' },
      { text: 'Creating Custom Tools', link: '/developer/creating-tools' },
      { text: 'Building UI Features', link: '/developer/plugin-development' },
      { text: 'Creating Prose Helpers', link: '/developer/creating-prose-helpers' },
      { text: 'Utility Modules', link: '/developer/utilities' },
    ],
  },
  {
    // DSK-254: REST, MCP and recipes, tokens and webhooks; the policies follow.
    text: 'Integrate',
    items: [
      { text: 'REST API', link: '/developer/rest-api' },
      { text: 'Wire Protocol & Clients', link: '/developer/collaboration-protocol' },
      { text: 'MCP Tools', link: '/developer/mcp-tools' },
      { text: 'AI Agents (MCP) & Recipes', link: '/developer/mcp-agent-recipes' },
      { text: 'App Token Format', link: '/developer/token-format' },
      { text: 'Token Revocation', link: '/developer/revocation' },
      { text: 'Webhooks', link: '/developer/webhooks' },
    ],
  },
  {
    text: 'Policies & Reference',
    items: [
      { text: 'Deprecation Policy', link: '/developer/deprecation-policy' },
      { text: 'Keyboard Shortcuts Reference', link: '/developer/keyboard-shortcuts-reference' },
      { text: 'Roadmap', link: '/developer/roadmap' },
    ],
  },
]
