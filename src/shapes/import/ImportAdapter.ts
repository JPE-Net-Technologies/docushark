/**
 * Import-adapter seam for the diagram engine.
 *
 * DocuShark's on-ramp is built around importing from other tools (Mermaid,
 * drawio, PlantUML, Excalidraw). This module defines the extension point those
 * adapters plug into; it intentionally ships no concrete parser yet (YAGNI —
 * the first real adapter brings its own).
 *
 * The contract is deliberately thin and aligns with the existing shape engine:
 * an adapter parses source text into standard `Shape` data, and — when it
 * introduces shape *kinds* the editor doesn't already know — supplies
 * `LibraryShapeDefinition`s. Those definitions register through the same path
 * the built-in libraries use (`useShapeLibraryStore.registerShapes`, see
 * `registerBuiltInShapes.ts`), so adapter-authored shapes get rendering, hit
 * testing, labels (via the shared label engine), and in-place editing for free.
 */

import type { Shape } from '../Shape';
import type { LibraryShapeDefinition } from '../library/ShapeLibraryTypes';

/**
 * The product of importing a source document.
 */
export interface ImportResult {
  /** Shapes to insert into the document. */
  shapes: Shape[];
  /**
   * Library shape definitions the produced shapes depend on. Register these via
   * `useShapeLibraryStore.registerShapes` before inserting the shapes.
   */
  libraryDefs?: LibraryShapeDefinition[];
}

/**
 * A pluggable importer for a single source format.
 */
export interface ImportAdapter {
  /** Stable identifier, e.g. 'mermaid' | 'drawio' | 'plantuml' | 'excalidraw'. */
  id: string;
  /** Human-readable name for menus. */
  label: string;
  /** Cheap sniff test: does this adapter recognize the given source text? */
  canImport(raw: string): boolean;
  /** Parse the source into shapes (+ any library definitions they need). */
  import(raw: string): ImportResult;
}

const registry = new Map<string, ImportAdapter>();

/**
 * Register an import adapter. Throws if the id is already taken (mirrors
 * `ShapeRegistry.register` semantics).
 */
export function registerImportAdapter(adapter: ImportAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`Import adapter already registered: ${adapter.id}`);
  }
  registry.set(adapter.id, adapter);
}

/** Get a registered adapter by id. */
export function getImportAdapter(id: string): ImportAdapter | undefined {
  return registry.get(id);
}

/** All registered adapters. */
export function listImportAdapters(): ImportAdapter[] {
  return Array.from(registry.values());
}

/**
 * Find the first adapter that recognizes the given source text, or undefined.
 */
export function findImportAdapter(raw: string): ImportAdapter | undefined {
  for (const adapter of registry.values()) {
    if (adapter.canImport(raw)) return adapter;
  }
  return undefined;
}

/** Remove an adapter (test/dynamic use). */
export function unregisterImportAdapter(id: string): boolean {
  return registry.delete(id);
}
