/**
 * Sanitizer for the one place prose injects stored HTML as markup (JP-496).
 *
 * Almost nothing in this app assigns document-derived HTML to `innerHTML` —
 * prose renders through the ProseMirror schema, which drops anything it does not
 * model, and `ProsePreview` is a non-editable Tiptap instance for exactly that
 * reason. The bibliography node is the exception: its rendered entries are
 * cached in a `bibHtml` **attribute** so a reload shows them without waiting on
 * the async formatter, and the node view paints that cache with `innerHTML`.
 *
 * The value we *write* is safe — citation-js escapes reference metadata, so a
 * title of `<img src=x onerror=…>` comes back as `&#60;img …&#62;`. The value we
 * *read* is a different question: it arrives from the document, and a document
 * can be written by a collaborator, by an MCP agent, or by an import. The relay
 * stores the attribute escaped, so the HTML round-trip is fine — but the parse
 * hands back raw markup, and raw markup reaching `innerHTML` is stored XSS that
 * fires for every viewer of the document, including guests of a published one.
 *
 * So: sanitize on the way in. The allowlist is CSL's actual output vocabulary,
 * not a general-purpose HTML policy — anything outside it is markup a
 * bibliography had no business containing.
 */

/** Elements CSL styles emit. Everything else is unwrapped to its text. */
const ALLOWED_TAGS = new Set([
  'DIV',
  'SPAN',
  'P',
  'I',
  'EM',
  'B',
  'STRONG',
  'U',
  'SUP',
  'SUB',
  'SMALL',
  'BR',
  'A',
  'UL',
  'OL',
  'LI',
]);

/**
 * Attributes worth keeping. `class` and `data-csl-entry-id` carry the CSL
 * layout hooks the stylesheet targets; `href` is allowed only after a scheme
 * check.
 *
 * `style` is deliberately absent. It looks harmless, but it is the attribute
 * that keeps finding new ways to be a sink, and no CSL style needs it here.
 */
const ALLOWED_ATTRS = new Set(['class', 'data-csl-entry-id', 'href']);

/** Only these schemes may appear in an `href`. */
const SAFE_HREF = /^(https?:|mailto:|#)/i;

/**
 * Strip `html` down to the bibliography subset.
 *
 * Parsed with `DOMParser` into a **detached, inert document**: scripts do not
 * run and `src` attributes do not fetch, so the parse itself is not the moment
 * of danger — assigning the result to a live `innerHTML` would be.
 */
export function sanitizeBibliographyHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}

function clean(parent: Element): void {
  // Snapshot: the walk reparents and removes nodes as it goes.
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;

    if (node.nodeType !== Node.ELEMENT_NODE) {
      // Comments and anything else exotic carry no bibliography content.
      node.remove();
      continue;
    }

    const el = node as Element;

    if (!ALLOWED_TAGS.has(el.tagName)) {
      // Unwrap rather than delete: a disallowed wrapper should not take the
      // citation text inside it. `<script>`/`<style>` are the exception — their
      // "text" is code, and unwrapping would paint it as visible content.
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') {
        el.remove();
        continue;
      }
      clean(el);
      el.replaceWith(...el.childNodes);
      continue;
    }

    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // Every `on*` handler goes, checked BEFORE the allowlist and independent
      // of it. The allowlist alone would already drop these, but the allowlist
      // is the line someone edits when they need one more attribute — and
      // "add the attribute you need" is a much easier mistake to make than
      // "delete the handler check". Two independent reasons for a handler to
      // die is the right number.
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (!ALLOWED_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' && !SAFE_HREF.test(attr.value.trim())) {
        el.removeAttribute(attr.name);
      }
    }

    clean(el);
  }
}
