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
 * Get a cached icon image for rendering.
 * Returns undefined if the icon is not yet loaded or doesn't exist.
 *
 * This function starts loading the icon in the background if not cached.
 * When the icon loads, registered callbacks are notified.
 *
 * @param iconId - Icon ID (builtin: or custom)
 * @param color - Optional color to replace currentColor in SVG
 * @returns HTMLImageElement if ready, undefined otherwise
 */
export function getIconImage(
  iconId: string,
  color?: string
): HTMLImageElement | undefined {
  // Create cache key including color
  const cacheKey = color ? `${iconId}:${color}` : iconId;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.ready ? cached.image : undefined;
  }

  // Start loading
  loadIconAsync(iconId, color, cacheKey);

  return undefined;
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
