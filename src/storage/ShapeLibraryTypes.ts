/**
 * Type definitions for custom shape libraries.
 *
 * Custom shape libraries allow users to save shapes and groups
 * for reuse across documents.
 */

import type { Shape } from '../shapes/Shape';

/**
 * Custom shape library metadata.
 * Stored in Zustand (persisted to localStorage).
 */
export interface CustomShapeLibrary {
  /** Unique identifier */
  id: string;
  /** User-defined name */
  name: string;
  /** Optional description */
  description?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  modifiedAt: number;
  /** Number of items in this library */
  itemCount: number;
}

/**
 * Custom shape item metadata.
 * Full data stored in IndexedDB, metadata cached in Zustand.
 */
export interface CustomShapeItem {
  /** Unique identifier (content hash) */
  id: string;
  /** Parent library ID */
  libraryId: string;
  /** User-defined name */
  name: string;
  /** Whether this is a single shape or group */
  type: 'single' | 'group';
  /** Base64 data URL thumbnail for preview */
  thumbnail?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Usage count for reference tracking */
  usageCount: number;
  /** Serialized shape data */
  shapeData: SerializedShapeData;
}

/**
 * Serialized shape data with resolved children.
 * Groups include all nested shapes for self-contained storage.
 */
export interface SerializedShapeData {
  /** The root shape (may be a group) */
  rootShape: Shape;
  /** All child shapes for groups (flattened hierarchy) */
  childShapes: Shape[];
  /** Original bounding box for positioning */
  originalBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Result of a save operation.
 */
export interface SaveToLibraryResult {
  success: boolean;
  itemId?: string;
  error?: string;
}

/**
 * Export format for shape libraries.
 */
export interface ShapeLibraryExport {
  /** Format version */
  version: 1;
  /** Type identifier for validation */
  type: 'docushark-shape-library';
  /** Library metadata */
  library: {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
  };
  /** Library items */
  items: Array<{
    name: string;
    type: 'single' | 'group';
    thumbnail?: string;
    shapeData: SerializedShapeData;
  }>;
}

/**
 * Validate an export file structure.
 */
export function isValidShapeLibraryExport(data: unknown): data is ShapeLibraryExport {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  // Accept the legacy `diagrammer-shape-library` value too, for files
  // exported by pre-rename builds.
  const type = obj['type'];
  const validType =
    type === 'docushark-shape-library' || type === 'diagrammer-shape-library';

  return (
    obj['version'] === 1 &&
    validType &&
    typeof obj['library'] === 'object' &&
    obj['library'] !== null &&
    Array.isArray(obj['items'])
  );
}
