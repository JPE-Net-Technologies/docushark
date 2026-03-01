/**
 * IconTypes - Type definitions for the icon library system.
 *
 * Supports both built-in SVG icons and custom user-uploaded icons
 * stored in IndexedDB via the blob storage system.
 */

/**
 * Icon type classification.
 */
export type IconType = 'builtin' | 'custom';

/**
 * Categories for organizing icons.
 *
 * Core categories: arrows, shapes, symbols, tech, general
 * Cloud categories: cloud-aws, cloud-azure, cloud-gcp
 * Dev categories: devops, databases, languages, frameworks
 * User category: custom
 */
export type IconCategory =
  | 'arrows'
  | 'shapes'
  | 'symbols'
  | 'tech'
  | 'general'
  | 'cloud-aws'
  | 'cloud-azure'
  | 'cloud-gcp'
  | 'devops'
  | 'databases'
  | 'languages'
  | 'frameworks'
  | 'custom';

/**
 * Categories that are loaded lazily (on-demand).
 */
export const LAZY_ICON_CATEGORIES: IconCategory[] = [
  'cloud-aws',
  'cloud-azure',
  'cloud-gcp',
  'devops',
  'databases',
  'languages',
  'frameworks',
];

/**
 * Categories that are loaded at startup (small, frequently used).
 */
export const EAGER_ICON_CATEGORIES: IconCategory[] = [
  'arrows',
  'shapes',
  'symbols',
  'tech',
  'general',
];

/**
 * Human-readable display names for icon categories.
 */
export const ICON_CATEGORY_LABELS: Record<IconCategory, string> = {
  arrows: 'Arrows',
  shapes: 'Shapes',
  symbols: 'Symbols',
  tech: 'Tech',
  general: 'General',
  'cloud-aws': 'AWS',
  'cloud-azure': 'Azure',
  'cloud-gcp': 'GCP',
  devops: 'DevOps',
  databases: 'Databases',
  languages: 'Languages',
  frameworks: 'Frameworks',
  custom: 'Custom',
};

/**
 * Metadata for an icon in the library.
 */
export interface IconMetadata {
  /** Unique identifier: 'builtin:name' or SHA-256 hash for custom */
  id: string;

  /** Display name for the icon */
  name: string;

  /** Whether this is a built-in or custom icon */
  type: IconType;

  /** Category for organization */
  category: IconCategory;

  /** SVG content for built-in icons (inline) */
  svgContent?: string;

  /** Path to SVG asset file relative to public/icons/ (for file-based icons) */
  assetPath?: string;

  /** Whether the icon uses its own colors (multi-color, not currentColor) */
  multiColor?: boolean;

  /** Blob ID for custom icons (reference to IndexedDB) */
  blobId?: string;

  /** Original filename for custom icons */
  originalFilename?: string;

  /** When the icon was added (custom icons only) */
  createdAt?: number;

  /** Usage count in documents (for reference tracking) */
  usageCount?: number;
}

/**
 * Icon data including the actual content.
 */
export interface IconData extends IconMetadata {
  /** The SVG content as a string */
  content: string;

  /** Data URL for rendering (svg+xml base64) */
  dataUrl: string;

  /** Viewbox dimensions if extracted */
  viewBox?: {
    width: number;
    height: number;
  };
}

/**
 * Options for rendering an icon.
 */
export interface IconRenderOptions {
  /** Size in pixels (width = height) */
  size: number;

  /** Fill color (replaces currentColor in SVG) */
  color?: string;

  /** Padding from container edge */
  padding?: number;

  /** Opacity (0-1) */
  opacity?: number;
}

/**
 * Result of uploading a custom icon.
 */
export interface IconUploadResult {
  success: boolean;
  icon?: IconMetadata;
  error?: string;
}

/**
 * Statistics for the icon library.
 */
export interface IconLibraryStats {
  builtinCount: number;
  customCount: number;
  totalCount: number;
  customStorageBytes: number;
}
