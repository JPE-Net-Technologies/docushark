/**
 * Capture the docs screenshots in docs-site/public/screenshots from the real app.
 *
 * It drives a fresh browser profile (so no one's own documents appear), imports
 * the example documents from docs-site/public/examples, and photographs each
 * scene below at 1440×900, 1.5× density, in the dark theme.
 *
 * Run it against a production build, which has no development overlays such as
 * the FPS counter. From docushark-app/:
 *
 *   bun run build && bunx vite preview --port 4173 --strictPort
 *   node docs-site/scripts/capture-screenshots.cjs            # every scene
 *   node docs-site/scripts/capture-screenshots.cjs connectors  # one scene
 *
 * Playwright isn't a dependency of this repo. If `require('playwright')` can't
 * find it, set PLAYWRIGHT_FROM to a node_modules folder that has it. Other
 * settings: APP (default http://localhost:4173), OUT (default the screenshots
 * folder), EXAMPLES (default the examples folder) and SCALE (default 1.5).
 *
 * Two scenes select a shape by clicking a point on the canvas. If a layout
 * change moves the shape, the scene stops with an error rather than saving a
 * picture with nothing selected; update the point from a fresh capture.
 */
const path = require('node:path');
const { createRequire } = require('node:module');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    if (!process.env.PLAYWRIGHT_FROM) {
      throw new Error('Playwright not found: install it, or set PLAYWRIGHT_FROM to a node_modules folder that has it');
    }
    return createRequire(path.join(process.env.PLAYWRIGHT_FROM, '/'))('playwright');
  }
}

const DOCS_SITE = path.resolve(__dirname, '..');
const APP = process.env.APP ?? 'http://localhost:4173';
const OUT = process.env.OUT ?? path.join(DOCS_SITE, 'public/screenshots');
const EXAMPLES = process.env.EXAMPLES ?? path.join(DOCS_SITE, 'public/examples');
const SCALE = Number(process.env.SCALE ?? 1.5);

const DOCS = {
  research: { file: 'music-tempo-recall-study.docushark', name: 'Does Music Tempo Affect Recall?' },
  course: { file: 'intro-to-astronomy-course-plan.docushark', name: 'Intro to Astronomy' },
  content: { file: 'curious-minds-content-plan.docushark', name: 'Curious Minds' },
  cell: { file: 'cell-viability-assay.docushark', name: 'Cell Viability Assay' },
};

const IMPORT_BUTTON = '[title="Import a .docushark document (with its assets)"]';

async function goToDocuments(page) {
  // The library has the import button; the editor has a Documents button instead.
  if (await page.locator(IMPORT_BUTTON).isVisible()) return;
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.waitForTimeout(600);
}

async function importExamples(page) {
  await goToDocuments(page);
  for (const doc of Object.values(DOCS)) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator(IMPORT_BUTTON).click();
    await (await chooser).setFiles(path.join(EXAMPLES, doc.file));
    await page.waitForTimeout(1500);
  }
}

// The layout is app-wide and persists, so put it back to the default each time.
async function relaxed(page) {
  await page.keyboard.press('Control+Shift+1');
  await page.waitForTimeout(700);
}

async function open(page, key) {
  await goToDocuments(page);
  // A library card, not the same title in the editor beneath the library.
  await page.locator('.document-card__name').filter({ hasText: DOCS[key].name }).first().click();
  await page.waitForTimeout(1500);
  await relaxed(page);
}

async function focus(page, which) {
  // Named "Write", "Split" and "Canvas"; the shortcut is only their tooltip.
  await page.getByRole('button', { name: which, exact: true }).click();
  await page.waitForTimeout(900);
}

async function canvasPage(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(900);
}

async function fit(page) {
  await page.getByRole('button', { name: 'Zoom to fit' }).click();
  await page.waitForTimeout(900);
}

async function selectAt(page, x, y, what) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);
  const status = await page.locator('footer, [class*="status-bar"]').first().innerText();
  if (!/1 selected/.test(status)) throw new Error(`clicking (${x}, ${y}) didn't select ${what}`);
}

async function shot(page, name) {
  // Notifications (such as "Imported …") aren't part of what a picture explains.
  await page.addStyleTag({ content: '.notification-container { display: none !important; }' });
  await page.mouse.move(2, 2); // no hover states in the picture
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('saved', name);
}

const SCENES = {
  // Start here and the gallery: writing beside its diagram.
  async research(page) {
    await open(page, 'research');
    await focus(page, 'Split');
    await canvasPage(page, 'Canvas'); // the study design
    await fit(page);
    await shot(page, 'example-research-project');
  },
  async course(page) {
    await open(page, 'course');
    await focus(page, 'Split');
    await fit(page);
    await shot(page, 'example-course-plan');
  },
  async content(page) {
    await open(page, 'content');
    await focus(page, 'Split');
    await canvasPage(page, 'Canvas'); // the topic map
    await fit(page);
    await shot(page, 'example-content-plan');
  },
  // Write → Citations.
  async bibliography(page) {
    await open(page, 'research');
    await focus(page, 'Write');
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll('.ProseMirror h1, .ProseMirror h2')].find(
        (e) => e.textContent.trim() === 'References',
      );
      heading?.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(600);
    await shot(page, 'citations-bibliography');
  },
  // The gallery's lab protocol: every region docked, with a step selected.
  async cell(page) {
    await open(page, 'cell');
    await page.keyboard.press('Control+Shift+4'); // Power
    await page.waitForTimeout(900);
    // Power's default notes column is too narrow for its ribbon; widen it.
    const handle = await page.getByRole('separator', { name: 'Resize panel' }).boundingBox();
    if (!handle) throw new Error('no panel resize handle');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 150, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await fit(page);
    await selectAt(page, 834, 418, '"Incubate 48 h"');
    await shot(page, 'example-cell-viability');
  },
  // Draw → Connectors: a connector's routing and type in Properties.
  async connectors(page) {
    await open(page, 'content');
    await focus(page, 'Canvas');
    await canvasPage(page, 'Production Pipeline');
    await fit(page);
    await selectAt(page, 772, 482, 'the connector from "Review & QA" to "Publish"');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.waitForTimeout(900);
    await shot(page, 'connectors-pipeline');
  },
  // Make it yours → Appearance.
  async settings(page) {
    await relaxed(page);
    await page.getByRole('button', { name: /^Settings/ }).first().click();
    await page.waitForTimeout(700);
    await page.locator('nav button, [role=tablist] button, aside button').filter({ hasText: /^Appearance$/ }).first().click();
    await page.waitForTimeout(700);
    await shot(page, 'settings-appearance');
    await page.keyboard.press('Escape');
  },
};

(async () => {
  const { chromium } = loadPlaywright();
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !(name in SCENES));
  if (unknown.length) throw new Error(`unknown scene(s): ${unknown.join(', ')}; scenes: ${Object.keys(SCENES).join(', ')}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await importExamples(page);
  let failed = 0;
  for (const [name, scene] of Object.entries(SCENES)) {
    if (wanted.length && !wanted.includes(name)) continue;
    try {
      await scene(page);
    } catch (e) {
      failed += 1;
      console.log(`scene ${name} failed: ${e.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
