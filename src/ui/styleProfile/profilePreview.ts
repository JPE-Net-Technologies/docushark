/**
 * Faithful style-profile previews, drawn by the real shape handlers.
 *
 * The card swatch used to be a CSS `<div>` styled from four profile keys
 * (fill / stroke / strokeWidth / cornerRadius) — the universal facet and
 * nothing else. That made a profile carrying swimlane header chrome, ERD zebra
 * striping and a full icon configuration look identical to one carrying a fill
 * and nothing more. The preview was not merely incomplete, it actively
 * misrepresented what applying the profile would do.
 *
 * This module renders through `shapeRegistry` instead: create a real shape of
 * the requested type, apply the profile with the same `getProfileUpdates` the
 * canvas uses, and let the registered handler draw it. That is the construction
 * that keeps PNG export accurate, and it is deliberate here — memory of
 * JP-468/472/473 says every one of those was the same defect class: a second
 * implementation of something with no guard tying it to the first. A preview
 * hand-drawn from profile keys is exactly that second implementation.
 *
 * Shared by the manager's card swatch and (JP-301 PR 3) the Studio's per-family
 * matrix, so both are faithful for the same reason rather than by coincidence.
 */

import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { Vec2 } from '../../math/Vec2';
import { getProfileUpdates, type StyleProfile } from '../../store/styleProfileStore';
import type { Shape } from '../../shapes/Shape';

/** Options for a single swatch render. */
export interface ProfilePreviewOptions {
  /** Shape type to draw. Defaults to a rectangle — the most legible carrier of
   *  the universal facet plus corner radius and icons. */
  shapeType?: string;
  /** CSS pixel size of the square swatch. */
  size: number;
  /** Device pixel ratio to render at (crispness on HiDPI). */
  dpr?: number;
}

/**
 * Build a shape of `shapeType` with `profile` applied, sized to fill a
 * `size`×`size` box with a small inset so strokes aren't clipped at the edge.
 *
 * Exported for the Studio, which needs the shape itself (not just a bitmap) to
 * report which fields actually took effect.
 */
export function buildPreviewShape(
  profile: StyleProfile,
  shapeType: string,
  size: number,
): Shape | null {
  if (!shapeRegistry.hasHandler(shapeType)) return null;
  const handler = shapeRegistry.getHandler(shapeType);

  // Inset by the widest stroke the profile could draw, so a thick border is
  // fully visible rather than half-clipped by the swatch edge.
  const inset = Math.max(2, Math.min(6, profile.properties.strokeWidth ?? 2));
  const base = handler.create(new Vec2(inset, inset), `preview-${profile.id}`);

  // `create` returns the handler's default geometry; override it to fit the
  // swatch. Width/height live on BaseShape for every registered type.
  const sized = {
    ...base,
    x: size / 2,
    y: size / 2,
    width: Math.max(1, size - inset * 2),
    height: Math.max(1, size - inset * 2),
  } as Shape;

  // The same translation the canvas performs — no parallel interpretation of
  // profile keys lives here.
  return { ...sized, ...getProfileUpdates(profile, sized) } as Shape;
}

/**
 * Render a profile onto a canvas element. Returns `false` when the shape type
 * isn't registered or a 2D context isn't available, so callers can fall back
 * rather than show an empty box.
 *
 * The canvas is cleared first: swatches are re-rendered in place when a profile
 * changes, and a stale underdraw would show through a translucent fill.
 */
export function renderProfileSwatch(
  canvas: HTMLCanvasElement,
  profile: StyleProfile,
  options: ProfilePreviewOptions,
): boolean {
  const { size, shapeType = 'rectangle' } = options;
  const dpr = options.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const shape = buildPreviewShape(profile, shapeType, size);
  if (!shape) return false;

  canvas.width = Math.max(1, Math.round(size * dpr));
  canvas.height = Math.max(1, Math.round(size * dpr));
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // A handler may throw on a shape it considers malformed (a library shape
  // whose definition isn't loaded, say). A broken swatch must never take the
  // panel down with it — the caller falls back to the CSS approximation.
  try {
    shapeRegistry.getHandlerForShape(shape).render(ctx, shape);
  } catch (e) {
    console.warn('[profilePreview] handler render failed:', e);
    return false;
  }
  return true;
}
