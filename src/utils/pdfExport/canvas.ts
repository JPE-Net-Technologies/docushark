/**
 * Canvas content in PDF export: canvas pages embedded as images, and groups
 * embedded in prose.
 */

import type { JSONContent } from '@tiptap/core';
import { PDFDiagramEmbed } from '../../types/PDFExport';
import { exportToPng, type ExportData } from '../exportUtils';
import { useDocumentStore } from '../../store/documentStore';
import { isGroup, type GroupShape, type Shape, type ConnectorShape } from '../../shapes/Shape';
import { normalizeAutoColorsForExport } from '../../engine/ContrastResolver';
import { checkPageBreak, type PDFCanvasPage, type PDFRenderContext } from './context';
import { calculateScaledDimensions, getImageDimensions } from './images';
import { PDF_STYLE } from './style';

/**
 * Render all canvas pages as diagrams to PDF.
 * If canvasPages are provided, each page gets its own diagram with a title.
 * Falls back to the legacy single-page behavior using documentStore if no pages provided.
 */
export async function renderAllDiagramPages(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  canvasPages?: PDFCanvasPage[],
  themeBackground?: string
): Promise<void> {
  if (canvasPages && canvasPages.length > 0) {
    for (let i = 0; i < canvasPages.length; i++) {
      const page = canvasPages[i]!;
      if (page.shapeOrder.length === 0) continue;

      // Page break before each canvas page (except the first diagram page)
      if (i > 0) {
        ctx.doc.addPage();
        ctx.pageNumber++;
        ctx.y = ctx.marginTop;
      }

      // (Canvas page/tab names are intentionally not printed — pages are
      // separated by the hard page break above, not a per-page title heading.)

      await renderDiagramPageToPdf(ctx, embedOptions, page.shapes, page.shapeOrder, themeBackground);
    }
  } else {
    // Legacy: single page from documentStore
    await renderDiagramToPdf(ctx, embedOptions, themeBackground);
  }
}

/**
 * Render a single canvas page's shapes as a diagram image in the PDF.
 */
async function renderDiagramPageToPdf(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  shapes: Record<string, Shape>,
  shapeOrder: string[],
  themeBackground?: string
): Promise<void> {
  try {
    if (shapeOrder.length === 0) {
      return;
    }

    const exportData: ExportData = {
      shapes: normalizeAutoColorsForExport(shapes),
      shapeOrder,
      selectedIds: [],
    };

    const backgroundColor = embedOptions.useThemeBackground && themeBackground
      ? themeBackground
      : '#ffffff';

    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'all',
      scale: embedOptions.scale,
      background: backgroundColor,
      padding: 20,
      filename: 'diagram',
    });

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    const dimensions = await getImageDimensions(dataUrl);

    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    checkPageBreak(ctx, scaled.height + 10);

    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;
    ctx.doc.addImage({
      imageData: dataUrl,
      format: 'PNG',
      x,
      y: ctx.y,
      width: scaled.width,
      height: scaled.height,
      compression: ctx.imageCompression,
    });
    ctx.y += scaled.height + 10;

  } catch (error) {
    console.error('[PDF Export] Failed to embed diagram page:', error);
  }
}

/**
 * Render the diagram to PDF (legacy single-page path using documentStore).
 */
async function renderDiagramToPdf(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  themeBackground?: string
): Promise<void> {
  try {
    // Get shapes from documentStore
    const { shapes, shapeOrder } = useDocumentStore.getState();

    // Check if there are any shapes to export
    if (shapeOrder.length === 0) {
      return;
    }

    // Prepare export data (normalize AUTO colours → black for paper output)
    const exportData: ExportData = {
      shapes: normalizeAutoColorsForExport(shapes),
      shapeOrder,
      selectedIds: [], // Export all shapes
    };

    // Determine background color
    const backgroundColor = embedOptions.useThemeBackground && themeBackground
      ? themeBackground
      : '#ffffff';

    // Export diagram as PNG
    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'all',
      scale: embedOptions.scale,
      background: backgroundColor,
      padding: 20,
      filename: 'diagram',
    });

    // Convert blob to data URL
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    // Get image dimensions
    const dimensions = await getImageDimensions(dataUrl);

    // Calculate scaled dimensions to fit on page
    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    // Check if we need a page break
    checkPageBreak(ctx, scaled.height + 10);

    // Center the diagram
    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;

    // Add image to PDF
    ctx.doc.addImage({
      imageData: dataUrl,
      format: 'PNG',
      x,
      y: ctx.y,
      width: scaled.width,
      height: scaled.height,
      compression: ctx.imageCompression,
    });
    ctx.y += scaled.height + 10;

  } catch (error) {
    console.error('[PDF Export] Failed to embed diagram:', error);
  }
}

/**
 * Get all shape IDs within a group (recursive for nested groups).
 *
 * Also includes connectors whose endpoints are both attached to shapes in the
 * group, even if the connector itself isn't listed in `childIds`. Connectors
 * routed between grouped shapes are visually part of the group; without this
 * pass they'd be silently dropped from the embedded-group render and show as
 * gaps against the page background.
 */
function getGroupShapeIds(groupId: string, shapes: Record<string, unknown>): string[] {
  const group = shapes[groupId] as GroupShape | undefined;
  if (!group || !isGroup(group)) return [];

  const ids: string[] = [];
  const collected = new Set<string>();

  const walk = (gid: string): void => {
    const g = shapes[gid] as GroupShape | undefined;
    if (!g || !isGroup(g)) return;
    for (const childId of g.childIds) {
      if (collected.has(childId)) continue;
      ids.push(childId);
      collected.add(childId);
      const child = shapes[childId];
      if (child && isGroup(child as GroupShape)) {
        walk(childId);
      }
    }
  };
  walk(groupId);

  // Sweep connectors whose endpoints both attach to shapes already collected.
  const memberSet = new Set<string>([groupId, ...ids]);
  for (const id in shapes) {
    if (memberSet.has(id)) continue;
    const shape = shapes[id] as Shape | undefined;
    if (!shape || shape.type !== 'connector') continue;
    const conn = shape as ConnectorShape;
    if (
      conn.startShapeId &&
      conn.endShapeId &&
      memberSet.has(conn.startShapeId) &&
      memberSet.has(conn.endShapeId)
    ) {
      ids.push(id);
      memberSet.add(id);
    }
  }

  return ids;
}

/**
 * Render an embedded group node to PDF.
 */
export async function renderEmbeddedGroup(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const groupId = node.attrs?.['groupId'] as string | undefined;
  if (!groupId) {
    console.warn('[PDF Export] Embedded group node has no groupId');
    return;
  }

  try {
    // Get shapes from documentStore
    const { shapes, shapeOrder } = useDocumentStore.getState();

    const group = shapes[groupId];
    if (!group || !isGroup(group)) {
      console.warn('[PDF Export] Group not found:', groupId);
      return;
    }

    // Get all shapes within this group (including nested)
    const groupShapeIds = new Set([groupId, ...getGroupShapeIds(groupId, shapes)]);

    // Filter shapes to only include those in this group
    const groupShapes: Record<string, Shape> = {};
    for (const id of groupShapeIds) {
      if (shapes[id]) {
        groupShapes[id] = shapes[id];
      }
    }

    // Order shapes according to shapeOrder (maintain z-order)
    const groupShapeOrder = shapeOrder.filter((id) => groupShapeIds.has(id));

    const exportData: ExportData = {
      shapes: normalizeAutoColorsForExport(groupShapes),
      shapeOrder: groupShapeOrder,
      selectedIds: [groupId],
    };

    // Export as PNG at 2x scale for quality
    // Use larger padding to accommodate group labels that may be outside bounds
    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'selection',
      scale: 2,
      background: '#ffffff',
      padding: 40,
      filename: 'group',
    });

    // Convert blob to data URL
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    // Get image dimensions
    const dimensions = await getImageDimensions(dataUrl);

    // Calculate scaled dimensions to fit on page
    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    // Check if we need a page break
    checkPageBreak(ctx, scaled.height + 10);

    // Center the image
    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;

    // Add image to PDF
    ctx.doc.addImage({
      imageData: dataUrl,
      format: 'PNG',
      x,
      y: ctx.y,
      width: scaled.width,
      height: scaled.height,
      compression: ctx.imageCompression,
    });
    ctx.y += scaled.height + 8;

  } catch (error) {
    console.error('[PDF Export] Failed to render embedded group:', error);
  }
}
