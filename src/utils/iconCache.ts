/**
 * Icon cache for efficient canvas rendering.
 *
 * Caches HTMLImageElement objects for SVG icons so they can be
 * drawn synchronously to canvas. Handles async loading and
 * provides a callback for re-rendering when icons are ready.
 */

import { useIconLibraryStore } from '../store/iconLibraryStore';
import { svgToDataUrl } from './svgUtils';

/**
 * Cache entry for a loaded icon.
 */
interface CacheEntry {
  image: HTMLImageElement;
  ready: boolean;
  error: boolean;
}

/**
 * Global icon cache.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Callbacks to notify when an icon is loaded.
 */
const loadCallbacks = new Set<() => void>();

/**
 * Register a callback to be called when any icon finishes loading.
 * Used to trigger re-renders.
 */
export function onIconLoad(callback: () => void): () => void {
  loadCallbacks.add(callback);
  return () => loadCallbacks.delete(callback);
}

/**
 * Notify all listeners that an icon has loaded.
 */
function notifyLoaded(): void {
  for (const callback of loadCallbacks) {
    callback();
  }
}

/**
 * Resolve the cache key for an icon + colour variant.
 *
 * Multi-colour icons (cloud-provider sets with native fills) ignore the requested
 * colour entirely — every "variant" rasterises identically — so they share a
 * single colourless entry instead of forking a fresh (transparent-until-loaded)
 * entry on every recolour. `multiColor` is passed in so this stays pure/testable;
 * {@link getIconImage} sources it from the icon library store.
 */
export function resolveIconCacheKey(
  iconId: string,
  color: string | undefined,
  multiColor: boolean
): string {
  if (!color || multiColor) return iconId;
  return `${iconId}:${color}`;
}

/**
 * Find any already-rasterised image for this icon (the colourless base or any
 * loaded colour variant). Used as a placeholder so a recolour / reselect never
 * flashes the shape transparent while the exact variant rasterises.
 */
function readySiblingImage(iconId: string): HTMLImageElement | undefined {
  const base = cache.get(iconId);
  if (base?.ready) return base.image;
  const prefix = `${iconId}:`;
  for (const [key, entry] of cache) {
    if (entry.ready && key.startsWith(prefix)) return entry.image;
  }
  return undefined;
}

/**
 * Get a cached icon image for rendering.
 * Returns undefined only if nothing for this icon is rasterised yet.
 *
 * This function starts loading the icon in the background if not cached.
 * When the icon loads, registered callbacks are notified. While a specific
 * colour variant rasterises, an already-loaded sibling is returned so the shape
 * stays visible instead of going transparent.
 *
 * @param iconId - Icon ID (builtin: or custom)
 * @param color - Optional color to replace currentColor in SVG
 * @returns HTMLImageElement if any variant is ready, undefined otherwise
 */
export function getIconImage(
  iconId: string,
  color?: string
): HTMLImageElement | undefined {
  const multiColor = useIconLibraryStore.getState().getIcon(iconId)?.multiColor ?? false;
  const cacheKey = resolveIconCacheKey(iconId, color, multiColor);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.ready) return cached.image;
    // Loading (or errored): show a sibling variant rather than nothing.
    return readySiblingImage(iconId);
  }

  // Start loading; meanwhile fall back to any already-loaded variant.
  loadIconAsync(iconId, color, cacheKey);

  return readySiblingImage(iconId);
}

/**
 * Load an icon asynchronously and cache the result.
 */
async function loadIconAsync(
  iconId: string,
  color: string | undefined,
  cacheKey: string
): Promise<void> {
  // Create placeholder entry
  const entry: CacheEntry = {
    image: new Image(),
    ready: false,
    error: false,
  };
  cache.set(cacheKey, entry);

  try {
    // Get icon data from store
    const iconData = await useIconLibraryStore.getState().loadIconData(iconId);
    if (!iconData) {
      entry.error = true;
      return;
    }

    // Process SVG content - replace currentColor with the specified color
    // but skip for multi-color icons (cloud provider icons with native fills)
    let svgContent = iconData.content;
    if (color && !iconData.multiColor) {
      svgContent = svgContent.replace(/currentColor/g, color);
    }

    // Create data URL
    const dataUrl = svgToDataUrl(svgContent);

    // Load image
    return new Promise<void>((resolve) => {
      entry.image.onload = () => {
        entry.ready = true;
        notifyLoaded();
        resolve();
      };

      entry.image.onerror = () => {
        entry.error = true;
        resolve();
      };

      entry.image.src = dataUrl;
    });
  } catch {
    entry.error = true;
  }
}

/**
 * Draw an icon to a canvas context.
 * Returns true if the icon was drawn, false if not yet loaded.
 *
 * @param ctx - Canvas 2D context
 * @param iconId - Icon ID
 * @param x - X position (top-left corner)
 * @param y - Y position (top-left corner)
 * @param size - Icon size (width and height)
 * @param color - Fill color for the icon
 * @returns true if drawn, false if not yet loaded
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  iconId: string,
  x: number,
  y: number,
  size: number,
  color?: string
): boolean {
  const image = getIconImage(iconId, color);
  if (!image) {
    return false;
  }

  ctx.drawImage(image, x, y, size, size);
  return true;
}

/**
 * Draw an icon from a raw SVG string (rather than the user icon library).
 *
 * Used for built-in chrome glyphs rendered on the canvas — e.g. the file-shape
 * type icons — that share the lucide visual language but should NOT live in the
 * user's icon library / picker. Reuses the same image cache + `onIconLoad`
 * re-render notification as `drawIcon`, so the glyph appears once rasterised.
 *
 * @param ctx - Canvas 2D context
 * @param cacheKey - Stable identity for this SVG (e.g. `file-type:pdf`)
 * @param svg - Raw SVG markup (`currentColor` is replaced with `color`)
 * @param x - X position (top-left corner)
 * @param y - Y position (top-left corner)
 * @param size - Icon size (width and height)
 * @param color - Fill/stroke colour to substitute for `currentColor`
 * @returns true if drawn, false if not yet loaded
 */
export function drawRawSvgIcon(
  ctx: CanvasRenderingContext2D,
  cacheKey: string,
  svg: string,
  x: number,
  y: number,
  size: number,
  color?: string
): boolean {
  const image = getRawSvgImage(cacheKey, svg, color);
  if (!image) {
    return false;
  }
  ctx.drawImage(image, x, y, size, size);
  return true;
}

/**
 * Get (and lazily rasterise) a cached image for a raw SVG string.
 */
function getRawSvgImage(
  cacheKey: string,
  svg: string,
  color?: string
): HTMLImageElement | undefined {
  const key = color ? `${cacheKey}:${color}` : cacheKey;

  const cached = cache.get(key);
  if (cached) {
    return cached.ready ? cached.image : undefined;
  }

  loadRawSvgAsync(key, svg, color);
  return undefined;
}

/**
 * Rasterise a raw SVG string into a cached image.
 */
function loadRawSvgAsync(
  cacheKey: string,
  svg: string,
  color: string | undefined
): void {
  const entry: CacheEntry = {
    image: new Image(),
    ready: false,
    error: false,
  };
  cache.set(cacheKey, entry);

  const svgContent = color ? svg.replace(/currentColor/g, color) : svg;
  const dataUrl = svgToDataUrl(svgContent);

  entry.image.onload = () => {
    entry.ready = true;
    notifyLoaded();
  };
  entry.image.onerror = () => {
    entry.error = true;
  };
  entry.image.src = dataUrl;
}

/**
 * Clear a specific icon from the cache.
 * Use this when an icon is updated or deleted.
 */
export function clearIconCache(iconId: string): void {
  // Clear all cache entries for this icon (including color variants)
  for (const key of cache.keys()) {
    if (key === iconId || key.startsWith(`${iconId}:`)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear the entire icon cache.
 */
export function clearAllIconCache(): void {
  cache.clear();
}

/**
 * Preload icons for faster initial rendering.
 *
 * @param iconIds - Icon IDs to preload
 * @param color - Optional color variant
 */
export function preloadIcons(iconIds: string[], color?: string): void {
  for (const iconId of iconIds) {
    getIconImage(iconId, color);
  }
}
