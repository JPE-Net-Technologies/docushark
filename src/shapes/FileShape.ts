import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import {
  FileShape,
  Handle,
  HandleType,
  Anchor,
  AnchorPosition,
  DEFAULT_FILE_SHAPE,
} from './Shape';
import { ShapeMetadata, createStandardProperties } from './ShapeMetadata';
import { formatFileSize, getFileTypeIcon } from '../utils/fileUtils';
import { blobStorage } from '../storage/BlobStorage';

/** DocuShark's custom blob reference scheme (NOT the browser's native `blob:`). */
const BLOB_PREFIX = 'blob://';

// Module-level thumbnail cache to avoid re-decoding every frame. Keyed by shape id.
const thumbnailCache = new Map<string, HTMLImageElement>();

// Resolved object URLs for `blob://<hash>` thumbnails, keyed by content hash.
// Content-addressed, so an object URL is valid for that hash across shapes/docs;
// revoked + cleared on document switch via resetFileThumbnailCaches().
const blobObjectUrls = new Map<string, string>();

// Hashes with an in-flight BlobStorage load, to dedupe concurrent resolves.
const blobLoadsInFlight = new Set<string>();

// Module-level cache tracking blob availability (populated by BlobStorage checks)
// Maps blobRef -> boolean (true = exists, false = missing)
const blobAvailabilityCache = new Map<string, boolean>();

/**
 * Callbacks fired when a thumbnail blob finishes resolving (or an <img> decodes).
 * Mirrors iconCache.onIconLoad — the Renderer subscribes to trigger a redraw so
 * the next frame can draw an image that wasn't ready on the frame that requested it.
 */
const thumbnailLoadCallbacks = new Set<() => void>();

/**
 * Register a callback invoked whenever a thumbnail finishes loading.
 * Returns an unsubscribe function. Used to trigger canvas re-renders.
 */
export function onThumbnailLoad(callback: () => void): () => void {
  thumbnailLoadCallbacks.add(callback);
  return () => thumbnailLoadCallbacks.delete(callback);
}

/** Notify listeners that a thumbnail has loaded (or failed). */
function notifyThumbnailLoad(): void {
  for (const callback of thumbnailLoadCallbacks) {
    callback();
  }
}

/**
 * Extract the content hash from a `blob://<hash>` thumbnail string, or null if
 * the source is a regular (`data:`/`http(s):`) URL the browser can load directly.
 */
function blobHashFromThumbnail(thumbnail: string | undefined): string | null {
  if (!thumbnail || !thumbnail.startsWith(BLOB_PREFIX)) return null;
  return thumbnail.slice(BLOB_PREFIX.length);
}

/**
 * Load a `blob://` thumbnail's bytes from IndexedDB and cache an object URL.
 * Runs in the background; on completion notifies listeners so the canvas redraws.
 * Marks blob availability so the missing-blob overlay can reflect the result.
 */
function resolveBlobThumbnail(hash: string): void {
  if (blobObjectUrls.has(hash) || blobLoadsInFlight.has(hash)) return;
  blobLoadsInFlight.add(hash);

  void blobStorage
    .loadBlob(hash)
    .then((blob) => {
      if (blob) {
        blobObjectUrls.set(hash, URL.createObjectURL(blob));
        markBlobAvailable(hash);
      } else {
        markBlobMissing(hash);
      }
    })
    .catch(() => {
      markBlobMissing(hash);
    })
    .finally(() => {
      blobLoadsInFlight.delete(hash);
      notifyThumbnailLoad();
    });
}

/**
 * Mark a blob as available (exists in storage).
 * Called externally when blob is successfully loaded.
 */
export function markBlobAvailable(blobRef: string): void {
  blobAvailabilityCache.set(blobRef, true);
}

/**
 * Mark a blob as missing (not found in storage).
 * Called externally when blob load fails.
 */
export function markBlobMissing(blobRef: string): void {
  blobAvailabilityCache.set(blobRef, false);
}

/**
 * Check if a blob is known to be missing.
 * Returns undefined if status is unknown.
 */
export function isBlobMissing(blobRef: string): boolean | undefined {
  const status = blobAvailabilityCache.get(blobRef);
  if (status === undefined) return undefined;
  return !status;
}

/**
 * Reset all FileShape thumbnail caches. Called on document switch: revokes the
 * object URLs minted for `blob://` thumbnails (no leak), and drops the decoded
 * <img> + blob-availability state so the newly opened doc re-resolves cleanly.
 */
export function resetFileThumbnailCaches(): void {
  for (const url of blobObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  blobObjectUrls.clear();
  blobLoadsInFlight.clear();
  thumbnailCache.clear();
  blobAvailabilityCache.clear();
}

/**
 * @deprecated Use {@link resetFileThumbnailCaches}. Retained as an alias so the
 * blob-availability cache can still be cleared by name.
 */
export function clearBlobAvailabilityCache(): void {
  resetFileThumbnailCaches();
}

/**
 * Retrieve (or create and cache) an HTMLImageElement for a file shape's thumbnail.
 *
 * Thumbnails arrive either as a directly-loadable URL (`data:`/`http(s):`, the
 * locally-created case) or — after a relay doc round-trips through
 * `extractAssetsFromBundle` — as DocuShark's custom `blob://<hash>` scheme, which
 * the browser refuses to load. For the latter we resolve the hash to an object URL
 * via IndexedDB in the background (returning null until ready), mirroring how
 * TiptapEditor handles rich-text images.
 */
function getThumbnailImage(shape: FileShape): HTMLImageElement | null {
  const thumbnail = shape.preview?.thumbnail;
  if (!thumbnail) return null;

  // Resolve the effective, browser-loadable source.
  let src: string;
  const hash = blobHashFromThumbnail(thumbnail);
  if (hash) {
    const objectUrl = blobObjectUrls.get(hash);
    if (!objectUrl) {
      // Not resolved yet — kick off the load and let this frame fall through to
      // the emoji/⚠ branch; the load notifies the renderer to redraw when done.
      resolveBlobThumbnail(hash);
      return null;
    }
    src = objectUrl;
  } else {
    src = thumbnail;
  }

  const key = shape.id;
  const cached = thumbnailCache.get(key);
  if (cached && cached.dataset['src'] === src) return cached;

  const img = new Image();
  img.dataset['src'] = src;
  // Even data: thumbnails decode asynchronously — redraw once the bitmap is ready.
  img.onload = notifyThumbnailLoad;
  img.src = src;
  thumbnailCache.set(key, img);
  return img;
}

/**
 * Get the four corners of a file shape in local space (before rotation).
 */
function getLocalCorners(shape: FileShape): Vec2[] {
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;

  return [
    new Vec2(-halfWidth, -halfHeight),
    new Vec2(halfWidth, -halfHeight),
    new Vec2(halfWidth, halfHeight),
    new Vec2(-halfWidth, halfHeight),
  ];
}

/**
 * Transform a local point to world space.
 */
function localToWorld(local: Vec2, shape: FileShape): Vec2 {
  const rotated = local.rotate(shape.rotation);
  return new Vec2(rotated.x + shape.x, rotated.y + shape.y);
}

/**
 * Transform a world point to local space.
 */
function worldToLocal(world: Vec2, shape: FileShape): Vec2 {
  const translated = new Vec2(world.x - shape.x, world.y - shape.y);
  return translated.rotate(-shape.rotation);
}

/**
 * Get the four corners of a file shape in world space.
 */
function getWorldCorners(shape: FileShape): Vec2[] {
  return getLocalCorners(shape).map((corner) => localToWorld(corner, shape));
}

/**
 * Draw a rounded rectangle path on the canvas context.
 */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

/**
 * Truncate text with ellipsis to fit within a maximum pixel width.
 */
function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

/**
 * File shape handler implementation.
 */
export const fileShapeHandler: ShapeHandler<FileShape> = {
  /**
   * Render a file shape as a card with thumbnail/icon area and bottom info bar.
   */
  render(ctx: CanvasRenderingContext2D, shape: FileShape): void {
    const { x, y, width, height, rotation, fill, stroke, strokeWidth, opacity } = shape;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y);
    ctx.rotate(rotation);

    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const cornerRadius = Math.min(8, halfWidth, halfHeight);

    // Draw card background
    ctx.beginPath();
    roundedRectPath(ctx, -halfWidth, -halfHeight, width, height, cornerRadius);
    ctx.closePath();

    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }

    // Bottom bar dimensions
    const bottomBarHeight = Math.min(36, height * 0.25);
    const thumbAreaHeight = height - bottomBarHeight;
    const thumbAreaTop = -halfHeight;
    const barTop = -halfHeight + thumbAreaHeight;

    // --- Thumbnail area ---
    const thumbImg = getThumbnailImage(shape);
    if (thumbImg && thumbImg.complete && thumbImg.naturalWidth > 0) {
      // Scale image to fit within thumbnail area, preserving aspect ratio
      const padding = 8;
      const availW = width - padding * 2;
      const availH = thumbAreaHeight - padding * 2;
      const imgAspect = thumbImg.naturalWidth / thumbImg.naturalHeight;
      const areaAspect = availW / availH;

      let drawW: number;
      let drawH: number;
      if (imgAspect > areaAspect) {
        drawW = availW;
        drawH = availW / imgAspect;
      } else {
        drawH = availH;
        drawW = availH * imgAspect;
      }

      const drawX = -drawW / 2;
      const drawY = thumbAreaTop + (thumbAreaHeight - drawH) / 2;

      // Clip to card bounds to prevent overflow
      ctx.save();
      ctx.beginPath();
      ctx.rect(-halfWidth, thumbAreaTop, width, thumbAreaHeight);
      ctx.clip();
      ctx.drawImage(thumbImg, drawX, drawY, drawW, drawH);
      ctx.restore();
    } else {
      // No thumbnail — draw category emoji centered
      const icon = getFileTypeIcon(shape.fileCategory);
      const emojiSize = Math.max(16, width * 0.25);
      ctx.font = `${emojiSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = shape.labelColor ?? DEFAULT_FILE_SHAPE.labelColor;
      ctx.fillText(icon, 0, thumbAreaTop + thumbAreaHeight / 2);
    }

    // --- Separator line ---
    if (stroke) {
      ctx.beginPath();
      ctx.moveTo(-halfWidth, barTop);
      ctx.lineTo(halfWidth, barTop);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.5, strokeWidth * 0.5);
      ctx.stroke();
    }

    // --- Bottom bar background ---
    ctx.save();
    ctx.beginPath();
    // Clip to the bottom rounded portion of the card
    roundedRectPath(ctx, -halfWidth, -halfHeight, width, height, cornerRadius);
    ctx.clip();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(-halfWidth, barTop, width, bottomBarHeight);
    ctx.restore();

    // --- Bottom bar text ---
    const labelColor = shape.labelColor ?? DEFAULT_FILE_SHAPE.labelColor;
    const fontSize = shape.labelFontSize ?? DEFAULT_FILE_SHAPE.labelFontSize;
    const barCenterY = barTop + bottomBarHeight / 2;
    const barPadding = 8;

    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = labelColor;

    // Category icon (emoji)
    const categoryIcon = getFileTypeIcon(shape.fileCategory);
    ctx.textAlign = 'left';
    const iconX = -halfWidth + barPadding;
    ctx.fillText(categoryIcon, iconX, barCenterY);
    const iconWidth = ctx.measureText(categoryIcon).width;

    // File size on the right
    const sizeText = formatFileSize(shape.fileSize);
    ctx.textAlign = 'right';
    const sizeX = halfWidth - barPadding;
    ctx.fillStyle = labelColor;
    ctx.globalAlpha = opacity * 0.7;
    ctx.fillText(sizeText, sizeX, barCenterY);
    ctx.globalAlpha = opacity;
    const sizeWidth = ctx.measureText(sizeText).width;

    // Filename (or custom label), truncated to fit
    const displayName = shape.label || shape.fileName;
    const nameStartX = iconX + iconWidth + 4;
    const nameMaxWidth = width - barPadding * 2 - iconWidth - 4 - sizeWidth - 6;
    if (nameMaxWidth > 10) {
      const truncatedName = truncateText(ctx, displayName, nameMaxWidth);
      ctx.textAlign = 'left';
      ctx.fillStyle = labelColor;
      ctx.fillText(truncatedName, nameStartX, barCenterY);
    }

    // --- Missing blob indicator ---
    // Show warning overlay if the file blob OR its thumbnail blob is known to be
    // missing. FileViewerModal marks the file `blobRef` when opened; the canvas
    // thumbnail resolver marks the thumbnail hash when its load fails.
    const thumbHash = blobHashFromThumbnail(shape.preview?.thumbnail);
    const fileMissing = shape.blobRef ? isBlobMissing(shape.blobRef) === true : false;
    const thumbMissing = thumbHash ? isBlobMissing(thumbHash) === true : false;
    if (fileMissing || thumbMissing) {
      // Semi-transparent red overlay
      ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      ctx.beginPath();
      roundedRectPath(ctx, -halfWidth, -halfHeight, width, height, cornerRadius);
      ctx.closePath();
      ctx.fill();

      // Warning icon in center of thumbnail area
      const warningSize = Math.max(20, width * 0.15);
      ctx.font = `${warningSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
      ctx.fillText('⚠', 0, thumbAreaTop + thumbAreaHeight / 2);
    }

    ctx.restore();
  },

  /**
   * Test if a world point is inside the file shape.
   */
  hitTest(shape: FileShape, worldPoint: Vec2): boolean {
    const local = worldToLocal(worldPoint, shape);
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;
    const strokePadding = shape.strokeWidth / 2;

    return (
      local.x >= -halfWidth - strokePadding &&
      local.x <= halfWidth + strokePadding &&
      local.y >= -halfHeight - strokePadding &&
      local.y <= halfHeight + strokePadding
    );
  },

  /**
   * Get the axis-aligned bounding box accounting for rotation.
   */
  getBounds(shape: FileShape): Box {
    const corners = getWorldCorners(shape);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const corner of corners) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }

    const padding = shape.strokeWidth / 2;
    return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
  },

  /**
   * Get resize and rotation handles (8 resize + 1 rotation).
   */
  getHandles(shape: FileShape): Handle[] {
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;
    const rotationHandleOffset = 30;

    const localHandles: Array<{ type: HandleType; x: number; y: number; cursor: string }> = [
      { type: 'top-left', x: -halfWidth, y: -halfHeight, cursor: 'nwse-resize' },
      { type: 'top', x: 0, y: -halfHeight, cursor: 'ns-resize' },
      { type: 'top-right', x: halfWidth, y: -halfHeight, cursor: 'nesw-resize' },
      { type: 'right', x: halfWidth, y: 0, cursor: 'ew-resize' },
      { type: 'bottom-right', x: halfWidth, y: halfHeight, cursor: 'nwse-resize' },
      { type: 'bottom', x: 0, y: halfHeight, cursor: 'ns-resize' },
      { type: 'bottom-left', x: -halfWidth, y: halfHeight, cursor: 'nesw-resize' },
      { type: 'left', x: -halfWidth, y: 0, cursor: 'ew-resize' },
      { type: 'rotation', x: 0, y: -halfHeight - rotationHandleOffset, cursor: 'grab' },
    ];

    return localHandles.map((h) => {
      const world = localToWorld(new Vec2(h.x, h.y), shape);
      return {
        type: h.type,
        x: world.x,
        y: world.y,
        cursor: h.cursor,
      };
    });
  },

  /**
   * Create a new file shape at the given position with placeholder values.
   */
  create(position: Vec2, id: string): FileShape {
    return {
      id,
      type: 'file',
      x: position.x,
      y: position.y,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: DEFAULT_FILE_SHAPE.fill,
      stroke: DEFAULT_FILE_SHAPE.stroke,
      strokeWidth: DEFAULT_FILE_SHAPE.strokeWidth,
      width: DEFAULT_FILE_SHAPE.width,
      height: DEFAULT_FILE_SHAPE.height,
      blobRef: '',
      fileName: 'Untitled',
      mimeType: 'application/octet-stream',
      fileSize: 0,
      fileCategory: 'generic',
      labelFontSize: DEFAULT_FILE_SHAPE.labelFontSize,
      labelColor: DEFAULT_FILE_SHAPE.labelColor,
    };
  },

  /**
   * Get connector anchor points: center + 4 edge midpoints.
   */
  getAnchors(shape: FileShape): Anchor[] {
    const { width, height } = shape;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    const localAnchors: Array<{ position: AnchorPosition; x: number; y: number }> = [
      { position: 'center', x: 0, y: 0 },
      { position: 'top', x: 0, y: -halfHeight },
      { position: 'right', x: halfWidth, y: 0 },
      { position: 'bottom', x: 0, y: halfHeight },
      { position: 'left', x: -halfWidth, y: 0 },
    ];

    return localAnchors.map((a) => {
      const world = localToWorld(new Vec2(a.x, a.y), shape);
      return {
        position: a.position,
        x: world.x,
        y: world.y,
      };
    });
  },
};

/**
 * Shape metadata for PropertyPanel rendering.
 */
const fileShapeMetadata: ShapeMetadata = {
  type: 'file',
  name: 'File',
  category: 'basic',
  icon: '📄',
  properties: [
    ...createStandardProperties({ includeDimensions: true }),
    {
      key: 'fileName',
      label: 'File Name',
      type: 'string',
      section: 'custom',
    },
    {
      key: 'label',
      label: 'Display Label',
      type: 'string',
      section: 'label',
      placeholder: 'Uses filename if empty',
    },
    {
      key: 'labelFontSize',
      label: 'Label Size',
      type: 'number',
      section: 'label',
      min: 8,
      max: 36,
      step: 1,
      default: 12,
    },
    {
      key: 'labelColor',
      label: 'Label Color',
      type: 'color',
      section: 'label',
    },
  ],
  supportsLabel: true,
  supportsIcon: false,
  defaultWidth: 200,
  defaultHeight: 160,
  description: 'Embedded file with preview thumbnail',
};

// Register the file shape handler
shapeRegistry.register('file', fileShapeHandler, fileShapeMetadata);
