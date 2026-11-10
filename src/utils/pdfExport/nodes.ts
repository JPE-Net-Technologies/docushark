/**
 * Registers a PDF renderer for every Tiptap node type the exporter supports.
 * To add PDF support for a new Tiptap extension, add one
 * `pdfNodeRenderers.register(...)` call here: there is no switch to change.
 * `warnUnhandledNodes` reports a document node with no renderer.
 */

import {
  renderBibliography,
  renderBlockquote,
  renderBulletList,
  renderCallout,
  renderCodeBlock,
  renderHeading,
  renderHorizontalRule,
  renderListItem,
  renderOrderedList,
  renderParagraph,
  renderTaskItem,
  renderTaskList,
} from './blocks';
import { renderEmbeddedGroup } from './canvas';
import { renderMathBlock, renderMathInline } from './math';
import { renderFigure, renderGallery, renderImage } from './media';
import { pdfNodeRenderers } from './registry';
import { renderTable } from './tables';

pdfNodeRenderers.register('heading', (ctx, node) => {
  renderHeading(ctx, node);
});

pdfNodeRenderers.register('paragraph', (ctx, node, listLevel) => {
  renderParagraph(ctx, node, listLevel);
});

pdfNodeRenderers.register('bulletList', (ctx, node, listLevel) =>
  renderBulletList(ctx, node, listLevel)
);

pdfNodeRenderers.register('orderedList', (ctx, node, listLevel) =>
  renderOrderedList(ctx, node, listLevel)
);

pdfNodeRenderers.register('listItem', (ctx, node, listLevel, listCounter) =>
  renderListItem(ctx, node, listLevel, listCounter)
);

pdfNodeRenderers.register('codeBlock', (ctx, node) => {
  renderCodeBlock(ctx, node);
});

pdfNodeRenderers.register('blockquote', (ctx, node) =>
  renderBlockquote(ctx, node)
);

pdfNodeRenderers.register('image', (ctx, node) =>
  renderImage(ctx, node)
);

pdfNodeRenderers.register('horizontalRule', (ctx) => {
  renderHorizontalRule(ctx);
});

pdfNodeRenderers.register('embeddedGroup', (ctx, node) =>
  renderEmbeddedGroup(ctx, node)
);

pdfNodeRenderers.register('taskList', (ctx, node, listLevel) =>
  renderTaskList(ctx, node, listLevel)
);

pdfNodeRenderers.register('taskItem', (ctx, node, listLevel) =>
  renderTaskItem(ctx, node, listLevel)
);

pdfNodeRenderers.register('table', (ctx, node) =>
  renderTable(ctx, node)
);

// tableRow/Cell/Header are handled internally by renderTable — no-ops prevent warnings
pdfNodeRenderers.register('tableRow', () => {});

pdfNodeRenderers.register('tableCell', () => {});

pdfNodeRenderers.register('tableHeader', () => {});

pdfNodeRenderers.register('bibliography', (ctx, node) => {
  renderBibliography(ctx, node);
});

pdfNodeRenderers.register('mathInline', (ctx, node) =>
  renderMathInline(ctx, node)
);

pdfNodeRenderers.register('mathBlock', (ctx, node) =>
  renderMathBlock(ctx, node)
);

// hardBreak is handled inline by extractSegments
pdfNodeRenderers.register('hardBreak', () => {});

// citationInline is handled inline by extractSegments (renders its cached label)
pdfNodeRenderers.register('citationInline', () => {});

// fieldRef is likewise handled inline by extractSegments (renders cached value)
pdfNodeRenderers.register('fieldRef', () => {});

// New prose nodes (Phase 1-2)
pdfNodeRenderers.register('callout', (ctx, node) => renderCallout(ctx, node));

pdfNodeRenderers.register('figure', (ctx, node) => renderFigure(ctx, node));

pdfNodeRenderers.register('figcaption', () => {}); // rendered inside renderFigure

pdfNodeRenderers.register('gallery', (ctx, node) => renderGallery(ctx, node));

/**
 * Log warnings for any Tiptap extension node types that don't have
 * a registered PDF renderer. Call this at export time to surface gaps.
 *
 * @param extensionNames - Node type names from the Tiptap extensions array
 */
export function warnUnhandledNodes(extensionNames: string[]): void {
  const registered = new Set(pdfNodeRenderers.getRegisteredTypes());
  // These meta-types are always handled implicitly
  registered.add('doc');
  registered.add('text');

  const missing = extensionNames.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    console.warn(
      `[PDF Export] The following Tiptap node types have no PDF renderer registered: ${missing.join(', ')}. ` +
      'Content of these types will fall through to child rendering.'
    );
  }
}
