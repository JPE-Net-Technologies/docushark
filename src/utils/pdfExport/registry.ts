/**
 * The PDF node renderer registry: one renderer per Tiptap node type, looked up
 * by `renderNode`. Renderers are registered in `nodes.ts`.
 */

import type { JSONContent } from '@tiptap/core';
import type { PDFRenderContext } from './context';

/**
 * Signature for a registered PDF node renderer.
 *
 * Each Tiptap node type registers a function matching this signature.
 * The registry replaces the old switch/case in renderNode(), so adding
 * a new Tiptap extension only requires calling `pdfNodeRenderers.register()`.
 */
type PDFNodeRenderFn = (
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number,
  listCounter?: { value: number },
) => Promise<void> | void;

class PDFNodeRendererRegistry {
  private handlers = new Map<string, PDFNodeRenderFn>();

  /** Register a renderer for a Tiptap node type. */
  register(nodeType: string, fn: PDFNodeRenderFn): void {
    this.handlers.set(nodeType, fn);
  }

  /** Render a node. Falls back to rendering children for unknown types. */
  async render(
    ctx: PDFRenderContext,
    node: JSONContent,
    listLevel: number,
    listCounter?: { value: number },
  ): Promise<void> {
    const handler = node.type ? this.handlers.get(node.type) : undefined;
    if (handler) {
      await handler(ctx, node, listLevel, listCounter);
    } else if (node.type && node.type !== 'doc' && node.type !== 'text') {
      console.warn(`[PDF Export] No renderer registered for node type: "${node.type}"`);
      // Fall through: render children so content isn't silently lost
      if (node.content) {
        for (const child of node.content) {
          await this.render(ctx, child, listLevel, listCounter);
        }
      }
    } else if (node.content) {
      for (const child of node.content) {
        await this.render(ctx, child, listLevel, listCounter);
      }
    }
  }

  /** Return all registered node type names. */
  getRegisteredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

/** Singleton registry — renderers are registered after their functions are defined. */
export const pdfNodeRenderers = new PDFNodeRendererRegistry();

/**
 * Render a Tiptap node to PDF via the node renderer registry.
 */
export async function renderNode(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number,
  listCounter?: { value: number }
): Promise<void> {
  await pdfNodeRenderers.render(ctx, node, listLevel, listCounter);
}
