/**
 * RGB color components.
 */
export interface RGB {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

/**
 * RGBA color components.
 */
export interface RGBA extends RGB {
  a: number; // 0-1
}

/**
 * HSL color components.
 */
export interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

/**
 * Parse a hex color string to RGB.
 *
 * @param hex - Hex color string (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA)
 * @returns RGB components or null if invalid
 */
export function hexToRgb(hex: string): RGB | null {
  // Remove # if present
  const cleaned = hex.replace(/^#/, '');

  let r: number, g: number, b: number;

  if (cleaned.length === 3) {
    // #RGB format
    r = parseInt(cleaned[0]! + cleaned[0], 16);
    g = parseInt(cleaned[1]! + cleaned[1], 16);
    b = parseInt(cleaned[2]! + cleaned[2], 16);
  } else if (cleaned.length === 4) {
    // #RGBA format - ignore alpha for RGB
    r = parseInt(cleaned[0]! + cleaned[0], 16);
    g = parseInt(cleaned[1]! + cleaned[1], 16);
    b = parseInt(cleaned[2]! + cleaned[2], 16);
  } else if (cleaned.length === 6) {
    // #RRGGBB format
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else if (cleaned.length === 8) {
    // #RRGGBBAA format - ignore alpha for RGB
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    return null;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return null;
  }

  return { r, g, b };
}

/**
 * Parse a hex color string to RGBA.
 *
 * @param hex - Hex color string (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA)
 * @returns RGBA components or null if invalid
 */
export function hexToRgba(hex: string): RGBA | null {
  const cleaned = hex.replace(/^#/, '');

  let r: number, g: number, b: number, a: number;

  if (cleaned.length === 3) {
    r = parseInt(cleaned[0]! + cleaned[0], 16);
    g = parseInt(cleaned[1]! + cleaned[1], 16);
    b = parseInt(cleaned[2]! + cleaned[2], 16);
    a = 1;
  } else if (cleaned.length === 4) {
    r = parseInt(cleaned[0]! + cleaned[0], 16);
    g = parseInt(cleaned[1]! + cleaned[1], 16);
    b = parseInt(cleaned[2]! + cleaned[2], 16);
    a = parseInt(cleaned[3]! + cleaned[3], 16) / 255;
  } else if (cleaned.length === 6) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
    a = 1;
  } else if (cleaned.length === 8) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
    a = parseInt(cleaned.slice(6, 8), 16) / 255;
  } else {
    return null;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) {
    return null;
  }

  return { r, g, b, a };
}

/**
 * Convert RGB to hex color string.
 *
 * @param rgb - RGB color components
 * @returns Hex color string (#RRGGBB)
 */
export function rgbToHex(rgb: RGB): string {
  const r = Math.round(Math.max(0, Math.min(255, rgb.r)));
  const g = Math.round(Math.max(0, Math.min(255, rgb.g)));
  const b = Math.round(Math.max(0, Math.min(255, rgb.b)));

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Convert RGBA to hex color string.
 *
 * @param rgba - RGBA color components
 * @returns Hex color string (#RRGGBBAA)
 */
export function rgbaToHex(rgba: RGBA): string {
  const r = Math.round(Math.max(0, Math.min(255, rgba.r)));
  const g = Math.round(Math.max(0, Math.min(255, rgba.g)));
  const b = Math.round(Math.max(0, Math.min(255, rgba.b)));
  const a = Math.round(Math.max(0, Math.min(1, rgba.a)) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a.toString(16).padStart(2, '0')}`;
}

/**
 * Convert RGB to HSL.
 *
 * @param rgb - RGB color components
 * @returns HSL color components
 */
export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
      break;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Convert HSL to RGB.
 *
 * @param hsl - HSL color components
 * @returns RGB color components
 */
export function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;

  if (s === 0) {
    const gray = Math.round(l * 255);
    return { r: gray, g: gray, b: gray };
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Lighten a hex color by a percentage.
 *
 * @param hex - Hex color string
 * @param amount - Amount to lighten (0-100)
 * @returns Lightened hex color string
 */
export function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const hsl = rgbToHsl(rgb);
  hsl.l = Math.min(100, hsl.l + amount);
  return rgbToHex(hslToRgb(hsl));
}

/**
 * Darken a hex color by a percentage.
 *
 * @param hex - Hex color string
 * @param amount - Amount to darken (0-100)
 * @returns Darkened hex color string
 */
export function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const hsl = rgbToHsl(rgb);
  hsl.l = Math.max(0, hsl.l - amount);
  return rgbToHex(hslToRgb(hsl));
}

/**
 * Check if a color is considered "light" (for contrast calculations).
 *
 * @param hex - Hex color string
 * @returns true if the color is light
 */
export function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;

  // Calculate relative luminance using sRGB formula
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5;
}

/**
 * Get a contrasting text color (black or white) for a background color.
 *
 * @param backgroundColor - Hex color string
 * @returns '#000000' for light backgrounds, '#ffffff' for dark backgrounds
 */
export function getContrastColor(backgroundColor: string): string {
  return isLightColor(backgroundColor) ? '#000000' : '#ffffff';
}

/**
 * WCAG relative luminance of an sRGB color (0 = black, 1 = white).
 */
function relativeLuminance(rgb: RGB): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG contrast ratio between two colors (1:1 .. 21:1). Order-independent.
 * Invalid input yields 1 (worst case) so callers fail safe.
 *
 * @param a - Hex color string
 * @param b - Hex color string
 */
export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Linearly interpolate between two hex colors in sRGB space.
 *
 * @param a - Start hex color
 * @param b - End hex color
 * @param t - Amount toward `b` (0..1)
 * @returns Mixed hex color (#RRGGBB); returns `a` unchanged on invalid input
 */
export function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const m = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: ra.r + (rb.r - ra.r) * m,
    g: ra.g + (rb.g - ra.g) * m,
    b: ra.b + (rb.b - ra.b) * m,
  });
}

/**
 * Build an `rgba()` string from a hex color and an alpha (0..1).
 *
 * @param hex - Hex color string
 * @param alpha - Opacity 0..1
 * @returns `rgba(r, g, b, a)`; returns `hex` unchanged on invalid input
 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}
