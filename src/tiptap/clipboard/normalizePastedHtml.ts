/**
 * Tidy HTML pasted or dropped into prose before ProseMirror parses it (DSK-208).
 *
 * The parse keeps what the schema recognises and drops the rest. What it
 * recognised from Word and Google Docs was often not what the writer meant:
 *
 * - Word writes a list as paragraphs styled `mso-list:lN levelM`, each with
 *   its marker ("·", "o", "1.") as literal text. They arrived as paragraphs
 *   starting with the marker, with the nesting lost.
 * - Word and Google Docs put the source document's default text colour on
 *   every span (`color:windowtext`, `black`, `#000000`). The schema keeps
 *   colour, so pasted text stayed black in the dark theme.
 * - Word wraps each picture in its own paragraph; the image is a block, so an
 *   empty paragraph was left above it.
 * - Word's pictures can point at `file:` paths, which a web page can't read.
 *
 * Pure: DOMParser in, HTML out, so it can run for every paste and be tested on
 * fixtures. HTML copied from a ProseMirror editor (`data-pm-slice`) is ours,
 * already in the schema's shape, and its colours were chosen in the editor, so
 * only the unreadable-image rule applies to it.
 */

export interface NormalizedPaste {
  html: string;
  /** Images removed because the page can't read their source. */
  droppedImages: number;
}

export function normalizePastedHtml(html: string): NormalizedPaste {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const fromProseMirror = body.querySelector('[data-pm-slice]') !== null;

  if (!fromProseMirror) {
    convertWordLists(body);
    removeComments(body);
    tidyOfficeElements(body);
    stripDefaultColours(body);
  }
  const droppedImages = removeUnreadableImages(body);
  if (!fromProseMirror) unwrapImageParagraphs(body);

  return { html: body.innerHTML, droppedImages };
}

// --- Word lists --------------------------------------------------------------

interface ListParagraph {
  el: HTMLElement;
  level: number;
  ordered: boolean;
}

const MSO_LIST = /mso-list:\s*l\d+\s+level(\d+)/i;
const ORDERED_MARKER = /^\(?(\d+|[a-z]|[ivxlcdm]+)[.)]$/i;

function convertWordLists(root: HTMLElement): void {
  const items: ListParagraph[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('p[style*="mso-list"]'))) {
    const match = MSO_LIST.exec(el.getAttribute('style') ?? '');
    if (!match) continue;
    items.push({ el, level: Number(match[1]), ordered: ORDERED_MARKER.test(takeListMarker(el)) });
  }

  // Consecutive list paragraphs (nothing but whitespace between them) form one list.
  let run: ListParagraph[] = [];
  for (const item of items) {
    const previous = run[run.length - 1];
    if (previous && previousElement(item.el) !== previous.el) {
      buildList(run);
      run = [];
    }
    run.push(item);
  }
  if (run.length > 0) buildList(run);
}

/**
 * Remove a list paragraph's marker and return its text. Word writes the marker
 * between `[if !supportLists]` and `[endif]` (as downlevel or real comments),
 * and newer versions also mark it with `mso-list:Ignore`.
 */
function takeListMarker(el: HTMLElement): string {
  let marker = '';
  const ignored = el.querySelector<HTMLElement>('[style*="mso-list:Ignore" i], [style*="mso-list: Ignore" i]');
  if (ignored) {
    marker = ignored.textContent ?? '';
    ignored.remove();
  }

  const start = findComment(el, /^\[if !supportLists\]$/);
  if (start) {
    let node = start.nextSibling;
    while (node && !(node.nodeType === Node.COMMENT_NODE && /^\[endif\]$/.test((node as Comment).data.trim()))) {
      const next = node.nextSibling;
      if (!marker) marker = node.textContent ?? '';
      node.parentNode?.removeChild(node);
      node = next;
    }
  }
  // The marker's padding is non-breaking spaces; the marker is what precedes them.
  return marker.replace(/ /g, ' ').trim().split(/\s+/)[0] ?? '';
}

function findComment(root: Node, pattern: RegExp): Comment | null {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (pattern.test((node as Comment).data.trim())) return node as Comment;
  }
  return null;
}

function previousElement(el: Element): Element | null {
  let node = el.previousSibling;
  while (node && ((node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) || node.nodeType === Node.COMMENT_NODE)) {
    node = node.previousSibling;
  }
  return node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
}

/** Replace a run of list paragraphs with nested `<ul>`/`<ol>` lists. */
function buildList(run: ListParagraph[]): void {
  const first = run[0]!.el;
  const doc = first.ownerDocument;
  const stack: { level: number; ordered: boolean; list: HTMLElement }[] = [];
  let top: HTMLElement | null = null;

  for (const { el, level, ordered } of run) {
    while (stack.length > 0 && stack[stack.length - 1]!.level > level) stack.pop();
    let current = stack[stack.length - 1];
    if (current && current.level === level && current.ordered !== ordered) {
      stack.pop();
      current = stack[stack.length - 1];
    }
    if (!current || current.level < level) {
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      const parentItem = current?.list.lastElementChild;
      if (parentItem) parentItem.appendChild(list);
      else if (top) top.after(list);
      else first.before(list);
      if (!current && !parentItem) top = list;
      stack.push({ level, ordered, list });
      current = stack[stack.length - 1];
    }

    const item = doc.createElement('li');
    const paragraph = doc.createElement('p');
    while (el.firstChild) paragraph.appendChild(el.firstChild);
    item.appendChild(paragraph);
    current!.list.appendChild(item);
    el.remove();
  }
}

// --- Office markup -----------------------------------------------------------

function removeComments(root: HTMLElement): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
}

/**
 * Drop `<o:p>` (Word's empty paragraph mark), drawing markup and style blocks,
 * and unwrap other namespaced elements (`w:sdt` content controls hold text).
 */
function tidyOfficeElements(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('style, meta, link, xml, title'))) el.remove();
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (!el.isConnected || !el.tagName.includes(':')) continue;
    const name = el.tagName.toLowerCase();
    if (name === 'o:p' || name.startsWith('v:')) el.remove();
    else el.replaceWith(...Array.from(el.childNodes));
  }
}

// --- Colours -----------------------------------------------------------------

/**
 * Remove colours that are the source's default text or page colour, so the
 * text takes the theme's ink: black and near-black or near-white greys, the
 * Windows system colours, and transparent or white backgrounds. Colour the
 * writer chose (red, a dark blue heading) has hue and is kept.
 */
function stripDefaultColours(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[style]'))) {
    const kept = (el.getAttribute('style') ?? '')
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => {
        if (!declaration) return false;
        const colon = declaration.indexOf(':');
        if (colon < 0) return true;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (property.startsWith('mso-')) return false;
        if (property === 'color') return !isDefaultInk(value);
        if (property === 'background' || property === 'background-color') return !isDefaultPaper(value);
        return true;
      });
    if (kept.length > 0) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  }
  for (const font of Array.from(root.querySelectorAll('font[color]'))) {
    if (isDefaultInk(font.getAttribute('color') ?? '')) font.removeAttribute('color');
  }
}

const DEFAULT_INK_NAMES = new Set(['windowtext', 'black', 'auto', 'inherit', 'initial', 'currentcolor', 'canvastext', 'white']);
const DEFAULT_PAPER_NAMES = new Set(['transparent', 'white', 'window', 'none', 'inherit', 'initial', 'canvas', 'auto']);

export function isDefaultInk(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (DEFAULT_INK_NAMES.has(v)) return true;
  const rgb = parseRgb(v);
  if (!rgb) return false;
  const { lightness, saturation } = hsl(rgb);
  return saturation < 0.12 && (lightness < 0.4 || lightness > 0.94);
}

function isDefaultPaper(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (DEFAULT_PAPER_NAMES.has(v)) return true;
  const rgb = parseRgb(v);
  if (!rgb) return false;
  if (rgb.a === 0) return true;
  const { lightness, saturation } = hsl(rgb);
  return saturation < 0.12 && lightness > 0.94;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseRgb(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((p) => Number.isNaN(p))) return null;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  return null;
}

function hsl({ r, g, b }: Rgb): { lightness: number; saturation: number } {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return { lightness, saturation };
}

// --- Images ------------------------------------------------------------------

/** `file:` (Word's temporary copies), `cid:` (mail) and Safari's placeholder can't be loaded by the page. */
const UNREADABLE_IMAGE = /^(file:|cid:|webkit-fake-url:)/i;

function removeUnreadableImages(root: HTMLElement): number {
  let dropped = 0;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (src && !UNREADABLE_IMAGE.test(src)) continue;
    img.remove();
    if (src) dropped++;
  }
  return dropped;
}

/** A paragraph holding only images becomes the images, so no empty paragraph is left above them. */
function unwrapImageParagraphs(root: HTMLElement): void {
  for (const p of Array.from(root.querySelectorAll('p'))) {
    const images = p.querySelectorAll('img');
    if (images.length === 0) continue;
    if ((p.textContent ?? '').replace(/ /g, ' ').trim() !== '') continue;
    p.replaceWith(...Array.from(images));
  }
}
