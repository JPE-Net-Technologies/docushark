/**
 * What the canvas selection bar offers and where it goes (DSK-225). Pure, so the
 * rules can be tested without a canvas.
 */
import type { Box } from '../../math/Box';
import { isConnector, isFile, isGroup, isLine, isText, type Shape } from '../../shapes/Shape';
import { shapeSupportsLabel } from '../../store/styleProfile';
import type { StyleProfile } from '../../store/styleProfileStore';

export type ColorSlot = 'fill' | 'stroke' | 'text';

const SLOTS: ColorSlot[] = ['fill', 'stroke', 'text'];

export const SLOT_NAMES: Record<ColorSlot, string> = { fill: 'Fill', stroke: 'Stroke', text: 'Text colour' };

type ColorField = 'fill' | 'stroke' | 'labelColor' | 'backgroundColor' | 'borderColor';

/** Where a shape keeps a slot's colour, if it has that slot at all. */
function fieldFor(shape: Shape, slot: ColorSlot): ColorField | null {
  // Text draws its letters with `fill`.
  if (isText(shape)) return slot === 'text' ? 'fill' : null;
  // Groups draw a background and a border, not a fill and a stroke.
  if (isGroup(shape)) {
    if (slot === 'fill') return 'backgroundColor';
    return slot === 'stroke' ? 'borderColor' : 'labelColor';
  }
  if (isFile(shape)) return slot === 'text' ? 'labelColor' : null;
  if (isLine(shape)) return slot === 'stroke' ? 'stroke' : null;
  if (isConnector(shape)) {
    if (slot === 'fill') return null;
    return slot === 'stroke' ? 'stroke' : 'labelColor';
  }
  if (slot === 'text') return shapeSupportsLabel(shape.type) ? 'labelColor' : null;
  return slot;
}

/** The colours every selected shape has. */
export function colorSlots(shapes: Shape[]): ColorSlot[] {
  if (shapes.length === 0) return [];
  return SLOTS.filter((slot) => shapes.every((shape) => fieldFor(shape, slot) !== null));
}

/** The colour a shape shows in a slot: empty for none. */
export function slotColor(shape: Shape, slot: ColorSlot): string {
  const field = fieldFor(shape, slot);
  if (!field) return '';
  const record = shape as unknown as Record<string, unknown>;
  const value = record[field] as string | null | undefined;
  // A group's colours count only once it draws that part of itself.
  if (field === 'backgroundColor') return record['showBackground'] ? value || '#ffffff' : '';
  if (field === 'borderColor') return record['borderWidth'] ? value || '#000000' : '';
  // A label with no colour of its own is drawn in the stroke's.
  if (field === 'labelColor') return value || shape.stroke || '#000000';
  return value ?? '';
}

export function slotIsMixed(shapes: Shape[], slot: ColorSlot): boolean {
  return new Set(shapes.map((shape) => slotColor(shape, slot))).size > 1;
}

/** What setting a slot's colour means for this shape. */
export function colorUpdate(shape: Shape, slot: ColorSlot, color: string): Partial<Shape> {
  const field = fieldFor(shape, slot);
  if (!field) return {};
  const record = shape as unknown as Record<string, unknown>;
  // A group has to start drawing the part you just gave a colour.
  if (field === 'backgroundColor') {
    return { backgroundColor: color, showBackground: color !== '' } as Partial<Shape>;
  }
  if (field === 'borderColor') {
    return { borderColor: color, borderWidth: (record['borderWidth'] as number) || 1 } as Partial<Shape>;
  }
  return { [field]: color } as Partial<Shape>;
}

/** The profiles offered directly: the last used, then in their usual order. */
export function quickProfiles(offered: StyleProfile[], recentIds: string[], count = 3): StyleProfile[] {
  const recent = recentIds
    .map((id) => offered.find((profile) => profile.id === id))
    .filter((profile): profile is StyleProfile => profile !== undefined);
  return Array.from(new Set([...recent, ...offered])).slice(0, count);
}

/** Clear of the rotation handle, which stands above a selection. */
const CLEARANCE_ABOVE = 34;
const CLEARANCE_BELOW = 12;
const MARGIN = 8;

interface Size {
  width: number;
  height: number;
}

export interface BarPlacement {
  left: number;
  top: number;
}

/**
 * Where the bar goes, in canvas pixels: centred above the selection, below it if
 * there's no room above, and at the top if there's room for neither. Null when the
 * selection is off the canvas, as there's nothing for it to stand beside.
 *
 * `covered` is canvas taken from each side by an open panel.
 */
export function placeSelectionBar(
  bounds: Box,
  camera: { x: number; y: number; zoom: number },
  canvas: Size,
  bar: Size,
  covered: { left: number; right: number } = { left: 0, right: 0 },
): BarPlacement | null {
  const screenX = (x: number) => canvas.width / 2 + (x - camera.x) * camera.zoom;
  const screenY = (y: number) => canvas.height / 2 + (y - camera.y) * camera.zoom;
  const left = screenX(bounds.minX);
  const right = screenX(bounds.maxX);
  const top = screenY(bounds.minY);
  const bottom = screenY(bounds.maxY);
  if (right < 0 || left > canvas.width || bottom < 0 || top > canvas.height) return null;

  const above = top - CLEARANCE_ABOVE - bar.height;
  const below = bottom + CLEARANCE_BELOW;
  let y = MARGIN;
  if (above >= MARGIN) y = above;
  else if (below + bar.height <= canvas.height - MARGIN) y = below;

  const minX = covered.left + MARGIN;
  const maxX = canvas.width - covered.right - bar.width - MARGIN;
  const x = Math.max(minX, Math.min((left + right) / 2 - bar.width / 2, maxX));
  return { left: x, top: y };
}
