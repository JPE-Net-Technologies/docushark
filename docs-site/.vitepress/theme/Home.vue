<script setup lang="ts">
import { withBase } from 'vitepress'

const badge = withBase('/docushark-badge.png')
const logo = withBase('/docushark-logo.png')
const GH = 'https://github.com/JPE-Net-Technologies/docushark'

// Hero search button → open VitePress local search (it listens for ⌘/Ctrl-K).
function openSearch() {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
  )
}
</script>

<template>
  <div class="ds-home">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-copy">
          <span class="eyebrow"><span class="dot" />DocuShark Help &amp; Guides</span>
          <h1>Everything you need to <span class="accent">draw, write, and think</span> it through.</h1>
          <p class="tagline">Step-by-step guides for getting the most out of DocuShark — from your very first shape to diagrams you build with a whole team. No setup headaches, no jargon.</p>
          <button class="hero-search" type="button" @click="openSearch">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <span>Search the docs…</span>
            <span class="kbd"><kbd>⌘</kbd><kbd>K</kbd></span>
          </button>
          <div class="hero-actions">
            <a class="btn btn-primary" :href="withBase('/getting-started/introduction')">Get Started
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </a>
            <a class="btn btn-ghost" :href="withBase('/getting-started/quick-start')">Take the 5-minute tour</a>
          </div>
        </div>
        <div class="hero-art"><div class="hero-badge"><img :src="badge" alt="DocuShark" /></div></div>
      </div>
    </section>

    <!-- Area cards -->
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">Find your way around</span>
          <h2>Where would you like to start?</h2>
          <p>Jump straight to whatever you came here to do.</p>
        </div>
        <div class="cards-3">
          <article class="area-card">
            <div class="area-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
            </div>
            <h3>New to DocuShark</h3>
            <p>Start at the very beginning — what DocuShark is, how to install it, and a five-minute tour to your first diagram.</p>
            <div class="area-links">
              <a :href="withBase('/getting-started/introduction')">Introduction <span class="arr">→</span></a>
              <a :href="withBase('/getting-started/installation')">Installation <span class="arr">→</span></a>
              <a :href="withBase('/getting-started/quick-start')">Quick Start <span class="arr">→</span></a>
            </div>
          </article>
          <article class="area-card">
            <div class="area-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17.5" cy="6.5" r="3.5"/><path d="M6.5 14 3 21h7z"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </div>
            <h3>Draw &amp; diagram</h3>
            <p>Get hands-on with the canvas — drawing tools, smart connectors, and ready-made shape libraries for any kind of diagram.</p>
            <div class="area-links">
              <a :href="withBase('/guide/drawing-tools')">Drawing Tools <span class="arr">→</span></a>
              <a :href="withBase('/guide/connectors')">Connectors <span class="arr">→</span></a>
              <a :href="withBase('/guide/shape-libraries')">Shape Libraries <span class="arr">→</span></a>
            </div>
          </article>
          <article class="area-card">
            <div class="area-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 19v-2a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v2"/><circle cx="9.5" cy="8" r="3"/><path d="M21 19v-2a3 3 0 0 0-2.2-2.9M16 5.1a3 3 0 0 1 0 5.8"/></svg>
            </div>
            <h3>Write &amp; collaborate</h3>
            <p>Mix rich text with your diagrams, invite your team to edit live, and send the finished thing anywhere you need it.</p>
            <div class="area-links">
              <a :href="withBase('/guide/rich-text-editor')">Rich Text Editor <span class="arr">→</span></a>
              <a :href="withBase('/guide/collaboration')">Collaboration <span class="arr">→</span></a>
              <a :href="withBase('/guide/export-import')">Export &amp; Import <span class="arr">→</span></a>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Spotlight -->
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">Why people love it</span>
          <h2>A canvas that bends around how you think</h2>
          <p>Words and drawings live on one page, and the workspace reshapes itself around whatever you're doing right now.</p>
        </div>
        <div class="cards-3">
          <article class="spotlight">
            <div class="spot-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 4h8v16H3z"/><path d="M14 7h7M14 11h7M14 15h5"/></svg></div>
            <h3>Docs and diagrams, one page</h3>
            <p>Write a how-to and sketch its diagram right beside it — your notes and an endless drawing canvas in the same document. No jumping between apps, no screenshots that go stale.</p>
            <span class="spot-tag">One document, no tool-switching</span>
          </article>
          <article class="spotlight">
            <div class="spot-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="18" width="7" height="3" rx="1"/></svg></div>
            <h3>A workspace that flexes</h3>
            <p>Four ready-made layouts reshape the screen around the task — a calm, clean page for a quick note, or a full diagramming cockpit when you're mapping out something big.</p>
            <span class="spot-tag">Four ready-made layouts</span>
          </article>
          <article class="spotlight">
            <div class="spot-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="3.2"/></svg></div>
            <h3>Bring your own AI</h3>
            <p>DocuShark exposes a precise, high-performance toolset over the open MCP standard — so whatever agent harness you already use, from Claude.ai to Codex to Cursor, can read and build real documents: prose, diagrams, and references, surgically, right on the live canvas.</p>
            <span class="spot-tag">Works with any MCP agent</span>
          </article>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="section features">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">In the box</span>
          <h2>Everything you'd expect, and the parts no one else ships</h2>
        </div>
        <div class="cards-3 feature-grid">
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M16 19v-2a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v2"/><circle cx="9.5" cy="8" r="3"/><path d="M21 19v-2a3 3 0 0 0-2.2-2.9M16 5.1a3 3 0 0 1 0 5.8"/></svg></div>
            <h3>Real-time collaboration</h3>
            <p>Work on the same diagram together, live. See everyone's cursors as they move, and share with a single link.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="4" width="20" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg></div>
            <h3>Offline-first desktop</h3>
            <p>A desktop app that works with no internet at all — your documents live on your own computer, ready whenever you are. Free, forever.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg></div>
            <h3>Files live with your docs</h3>
            <p>Embed PDFs, spreadsheets, and datasets right next to the canvas, pinned wherever you want them.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17.5" cy="6.5" r="3.5"/><path d="M6.5 14 3 21h7z"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
            <h3>Shape libraries</h3>
            <p>Flowchart, UML, ERD, and cloud shapes out of the box — plus custom libraries you build, share, or import.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg></div>
            <h3>Stays fast on huge diagrams</h3>
            <p>Thousands of shapes stay smooth and responsive. DocuShark keeps up even when your diagram grows enormous.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7V5a2 2 0 0 1 2-2h3l2 2"/><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z"/></svg></div>
            <h3>Collections</h3>
            <p>Group related documents into named, colour-coded collections — your whole library, organised the way you think about it.</p>
          </article>
          <article class="feature">
            <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg></div>
            <h3>Import &amp; export</h3>
            <p>Bring diagrams in from Mermaid, draw.io, and Excalidraw. Send them out as PNG, SVG, PDF, or Markdown bundles.</p>
          </article>
        </div>
      </div>
    </section>

    <!-- Developer strip -->
    <section class="dev-strip">
      <div class="wrap">
        <div class="dev-card">
          <span class="dev-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg></span>
          <div class="dev-copy">
            <h3>Building on DocuShark?</h3>
            <p>Set up the repo, explore the architecture, and create your own shapes, tools, and plugins.</p>
          </div>
          <a class="dev-link" :href="withBase('/developer/architecture')">Developer docs
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </a>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="ds-footer">
      <div class="wrap">
        <div class="foot-grid">
          <div>
            <div class="foot-brand"><img :src="logo" alt="DocuShark" /><span>DocuShark</span></div>
            <p class="foot-tag">Thinking without overhead. Open-source diagramming, free for all, forever.</p>
          </div>
          <div>
            <h4>Guide</h4>
            <ul>
              <li><a :href="withBase('/getting-started/introduction')">Introduction</a></li>
              <li><a :href="withBase('/getting-started/quick-start')">Quick Start</a></li>
              <li><a :href="withBase('/guide/shape-libraries')">Shape Libraries</a></li>
              <li><a :href="withBase('/guide/collaboration')">Collaboration</a></li>
            </ul>
          </div>
          <div>
            <h4>Developer</h4>
            <ul>
              <li><a :href="withBase('/developer/project-setup')">Project Setup</a></li>
              <li><a :href="withBase('/developer/architecture')">Architecture</a></li>
              <li><a :href="withBase('/developer/creating-shapes')">Creating Shapes</a></li>
              <li><a :href="withBase('/developer/plugin-development')">Plugins</a></li>
            </ul>
          </div>
          <div>
            <h4>Project</h4>
            <ul>
              <li><a href="https://docushark.app" target="_blank" rel="noopener">Website</a></li>
              <li><a :href="GH" target="_blank" rel="noopener">GitHub</a></li>
              <li><a :href="withBase('/developer/contributing')">Contributing</a></li>
              <li><a :href="withBase('/developer/roadmap')">Roadmap</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <span>© 2026 JPE-Net Technologies · AGPL-3.0</span>
          <span>dev.docushark.app</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.ds-home { color: var(--vp-c-text-1); }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font: 600 12px/1 var(--vp-font-family-mono);
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--vp-c-brand-1);
}
.eyebrow .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--gold); box-shadow: 0 0 0 3px var(--vp-c-brand-soft); }

.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 18px; height: 44px; border-radius: 10px;
  font-size: 14px; font-weight: 600; border: 1px solid transparent; transition: background .2s, border-color .2s;
}
.btn-primary { background: var(--gold); color: var(--navy-1000); border-color: var(--gold-deep); }
.btn-primary:hover { background: var(--gold-soft); }
.btn-ghost { color: var(--vp-c-text-1); border-color: var(--vp-c-border); }
.btn-ghost:hover { border-color: var(--gold); }

/* Hero */
.hero {
  background:
    radial-gradient(120% 90% at 80% -10%, rgba(201,162,98,.12) 0%, transparent 45%),
    radial-gradient(100% 80% at 0% 0%, rgba(33,64,110,.10) 0%, transparent 50%);
}
.dark .hero {
  background:
    radial-gradient(120% 90% at 80% -10%, rgba(201,162,98,.14) 0%, transparent 45%),
    radial-gradient(110% 90% at 50% -30%, #16273f 0%, transparent 60%);
}
.hero-inner { max-width: 1120px; margin: 0 auto; padding: 72px 24px 56px; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 48px; align-items: center; }
.hero-copy { display: grid; gap: 20px; max-width: 560px; }
.hero h1 { margin: 0; font-size: clamp(38px, 5vw, 60px); line-height: 1.04; letter-spacing: -0.025em; font-weight: 700; text-wrap: balance; }
.hero h1 .accent { color: var(--vp-c-brand-1); }
.hero .tagline { margin: 0; font-size: 19px; line-height: 1.55; color: var(--vp-c-text-2); max-width: 48ch; }
.hero-search {
  display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 16px; max-width: 440px;
  border-radius: 10px; border: 1px solid var(--vp-c-border); background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-3); font-size: 15px; box-shadow: var(--vp-shadow-1); transition: border-color .2s;
}
.hero-search:hover { border-color: var(--gold); }
.hero-search .kbd { margin-left: auto; display: flex; gap: 3px; }
.hero-search kbd { font: 500 11px/20px var(--vp-font-family-mono); border: 1px solid var(--vp-c-divider); border-radius: 4px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-3); padding: 0 5px; }
.hero-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.hero-badge { width: 280px; height: 280px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 16px 50px rgba(10,21,37,.28)); }
.dark .hero-badge { filter: drop-shadow(0 16px 60px rgba(201,162,98,.22)); }
.hero-badge img { width: 100%; height: auto; }

/* Sections */
.section { padding: 56px 0; }
.section-head { display: grid; gap: 12px; margin-bottom: 32px; max-width: 640px; }
.section-head h2 { margin: 0; font-size: clamp(24px, 3vw, 32px); line-height: 1.1; letter-spacing: -0.02em; font-weight: 600; }
.section-head p { margin: 0; color: var(--vp-c-text-2); font-size: 16px; }
.cards-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }

/* Area cards */
.area-card { display: grid; gap: 14px; align-content: start; padding: 26px; background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 16px; box-shadow: var(--vp-shadow-1); transition: transform .2s, box-shadow .2s, border-color .2s; }
.area-card:hover { transform: translateY(-3px); box-shadow: var(--vp-shadow-3); border-color: var(--gold); }
.area-ico { width: 46px; height: 46px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); border: 1px solid rgba(201,162,98,.28); }
.area-ico svg { width: 23px; height: 23px; }
.area-card h3 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.015em; }
.area-card p { margin: 0; color: var(--vp-c-text-2); font-size: 14.5px; line-height: 1.55; }
.area-links { display: grid; gap: 7px; margin-top: 2px; padding-top: 14px; border-top: 1px dashed var(--vp-c-divider); }
.area-links a { display: flex; align-items: center; justify-content: space-between; gap: 8px; font: 500 13px/1.3 var(--vp-font-family-base); color: var(--vp-c-text-2); transition: color .2s; }
.area-links a:hover { color: var(--vp-c-brand-1); }
.area-links .arr { color: var(--vp-c-text-3); transition: transform .2s, color .2s; }
.area-links a:hover .arr { color: var(--vp-c-brand-1); transform: translateX(2px); }

/* Spotlight */
.spotlight { display: grid; gap: 14px; align-content: start; padding: 28px; background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 10px; position: relative; overflow: hidden; transition: transform .2s, box-shadow .2s, border-color .2s; }
.spotlight::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: linear-gradient(90deg, var(--gold), transparent 70%); opacity: .8; }
.spotlight:hover { transform: translateY(-3px); box-shadow: var(--vp-shadow-3); border-color: var(--gold); }
.spot-ico { width: 50px; height: 50px; border-radius: 13px; display: inline-flex; align-items: center; justify-content: center; color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border: 1px solid rgba(201,162,98,.28); }
.spot-ico svg { width: 26px; height: 26px; }
.spotlight h3 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.015em; }
.spotlight p { margin: 0; color: var(--vp-c-text-2); font-size: 14.5px; line-height: 1.6; }
.spot-tag { margin-top: 2px; font: 600 11.5px/1 var(--vp-font-family-mono); color: var(--vp-c-text-3); }

/* Features */
.features { background: var(--vp-c-bg-soft); border-top: 1px solid var(--vp-c-divider); border-bottom: 1px solid var(--vp-c-divider); }
.feature-grid { gap: 16px; }
.feature { display: grid; gap: 12px; align-content: start; padding: 24px; background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 10px; transition: border-color .2s, box-shadow .2s; }
.feature:hover { border-color: var(--gold); box-shadow: var(--vp-shadow-3); }
.feat-ico { width: 44px; height: 44px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border: 1px solid rgba(201,162,98,.24); }
.feat-ico svg { width: 22px; height: 22px; }
.feature h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.feature p { margin: 0; font-size: 14px; line-height: 1.55; color: var(--vp-c-text-2); }

/* Developer strip */
.dev-strip { padding: 0 0 8px; }
.dev-card { display: flex; align-items: center; gap: 20px; padding: 22px 26px; border: 1px solid var(--vp-c-divider); border-radius: 16px; background: var(--vp-c-bg-soft); }
.dev-ico { width: 44px; height: 44px; flex: none; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; color: var(--vp-c-text-2); background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); }
.dev-ico svg { width: 22px; height: 22px; }
.dev-copy { display: grid; gap: 3px; flex: 1; min-width: 0; }
.dev-copy h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.dev-copy p { margin: 0; font-size: 14px; color: var(--vp-c-text-2); line-height: 1.5; }
.dev-link { display: inline-flex; align-items: center; gap: 7px; flex: none; font: 600 13.5px/1 var(--vp-font-family-base); color: var(--vp-c-brand-1); padding: 10px 16px; border-radius: 10px; border: 1px solid var(--vp-c-border); transition: border-color .2s, background .2s; }
.dev-link:hover { border-color: var(--gold); background: var(--vp-c-brand-soft); }

/* Footer */
.ds-footer { padding: 48px 0; margin-top: 8px; }
.foot-grid { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; gap: 28px; }
.ds-footer h4 { margin: 0 0 14px; font: 600 12px/1 var(--vp-font-family-mono); letter-spacing: 0.1em; text-transform: uppercase; }
.ds-footer ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
.ds-footer ul a { font-size: 14px; color: var(--vp-c-text-2); transition: color .2s; }
.ds-footer ul a:hover { color: var(--vp-c-brand-1); }
.foot-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.foot-brand img { height: 32px; }
.foot-brand span { font-weight: 700; letter-spacing: -0.015em; }
.foot-tag { color: var(--vp-c-text-2); font-size: 14px; max-width: 30ch; line-height: 1.55; }
.foot-bottom { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 40px; padding-top: 22px; border-top: 1px solid var(--vp-c-divider); font: 500 12.5px/1 var(--vp-font-family-mono); color: var(--vp-c-text-3); }

@media (max-width: 1080px) {
  .hero-inner { grid-template-columns: 1fr; }
  .hero-art { display: none; }
  .cards-3 { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 860px) {
  .cards-3 { grid-template-columns: 1fr; }
  .foot-grid { grid-template-columns: 1fr 1fr; }
  .dev-card { flex-wrap: wrap; gap: 14px; }
  .dev-link { width: 100%; justify-content: center; }
}
</style>
