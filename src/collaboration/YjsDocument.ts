/**
 * Yjs Document Wrapper for real-time collaborative editing.
 *
 * This module wraps a Yjs document to sync shape data between clients.
 * It uses Y.Map for shapes (keyed by shape ID) and handles bidirectional
 * synchronization with the local document store.
 *
 * Architecture:
 * - Y.Doc is the root collaborative document
 * - shapes:<pageId>: Y.Map<string, Shape> - shapes for one canvas page, keyed
 *   by ID (per-page, JP-340 — mirrors the per-page `prose:<id>` fragments)
 * - shapeOrder:<pageId>: Y.Array<string> - z-order of that page's shapes
 * - metadata: Y.Map - document metadata (title, etc.)
 *
 * The document store is the single render surface, so this wrapper binds ONE
 * active page's shape surface at a time and re-binds on a page switch
 * (`rebindActivePage`) — exactly how the prose editor binds one `prose:<id>`
 * fragment. Every page stays independently editable in the Y.Doc; switching
 * always reads the new page's current truth out of the (already-merged) Y.Doc.
 *
 * The sync flow:
 * 1. Local changes -> update the bound page's Y.Map -> broadcast to peers
 * 2. Remote changes -> Y.Map events -> update local store
 */

import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode, updateYFragment } from 'y-prosemirror';
import type { JSONContent } from '@tiptap/core';
import type { Shape } from '../shapes/Shape';
import type { CSLItem, CitationStyle, ReferenceLibrary } from '../types/Citation';
import type { Field, FieldLibrary } from '../types/Field';
import { getProseSchema } from './proseSchema';
import { CanvasUndoController } from './CanvasUndoController';

/**
 * Document metadata stored in Yjs
 */
export interface YjsDocumentMetadata {
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One prose page's metadata as a CRDT shared item (JP-339). Mirrors
 * `RichTextPage` **without `content`** — page content lives in its own
 * `prose:<id>` `Y.XmlFragment` (already CRDT-synced), so the page LIST syncs
 * only the tab metadata (name/color/order/timestamps). Storing content here too
 * would double-own it and fight the fragment.
 */
export interface ProsePageMeta {
  id: string;
  name: string;
  color?: string;
  order: number;
  createdAt?: number;
  modifiedAt?: number;
}

/**
 * The merged prose page-list snapshot — `pages` (id → meta) + a de-duplicated
 * `pageOrder` (filtered to existing pages, unordered pages appended). The
 * binding bulk-reloads `richTextPagesStore` from this on any remote change.
 * Mirrors {@link ReferenceLibrary} / {@link FieldLibrary}.
 */
export interface ProsePageList {
  pages: Record<string, ProsePageMeta>;
  pageOrder: string[];
}

/**
 * One canvas page's metadata as a CRDT shared item (JP-339). Mirrors the canvas
 * `Page` **without `shapes`/`shapeOrder`** — each page's shapes live in their own
 * `shapes:<id>` surface (JP-340), so the page LIST syncs only the tab metadata
 * (name/timestamps). A page's shapes are NOT double-owned here.
 */
export interface CanvasPageMeta {
  id: string;
  name: string;
  createdAt?: number;
  modifiedAt?: number;
}

/**
 * The merged canvas page-list snapshot — `pages` (id → meta) + a de-duplicated
 * `pageOrder`. The binding bulk-reloads `pageStore` from this on any remote
 * change. Mirrors {@link FieldLibrary}.
 */
export interface CanvasPageList {
  pages: Record<string, CanvasPageMeta>;
  pageOrder: string[];
}

/**
 * Callback for when shapes change from remote updates
 */
export type ShapeChangeCallback = (
  added: Shape[],
  updated: Shape[],
  removed: string[]
) => void;

/**
 * Callback for when shape order changes from remote updates
 */
export type OrderChangeCallback = (order: string[]) => void;

/**
 * Callback for when metadata changes from remote updates
 */
export type MetadataChangeCallback = (metadata: YjsDocumentMetadata) => void;

/**
 * Callback for when the reference library changes from remote updates (JP-89).
 * Coarse by design (no per-item args): the binding bulk-reloads `referenceStore`
 * from {@link YjsDocument.getReferenceLibrary} — the merged map snapshot — which
 * is what keeps a simultaneous MCP+author add from clobbering (INVARIANT B).
 */
export type ReferenceChangeCallback = () => void;

/**
 * Callback for when the document field library changes from remote updates
 * (Phase 3b). Coarse by design (no per-item args), mirroring
 * {@link ReferenceChangeCallback}: the binding bulk-reloads `fieldStore` from
 * {@link YjsDocument.getFieldLibrary} — the merged map snapshot — so a
 * simultaneous MCP+author field set can't clobber (INVARIANT A).
 */
export type FieldChangeCallback = () => void;

/**
 * Callback for when the prose page-list changes from remote updates (JP-339).
 * Coarse by design (no per-item args), mirroring {@link ReferenceChangeCallback}:
 * the binding bulk-reloads `richTextPagesStore` from
 * {@link YjsDocument.getProsePageList} — the merged snapshot — so a simultaneous
 * MCP+author page add/rename/reorder can't clobber, and the merge preserves each
 * page's already-synced `content`.
 */
export type ProsePagesChangeCallback = () => void;

/**
 * Callback for when the canvas page-list changes from remote updates (JP-339).
 * Coarse by design (no per-item args), mirroring {@link FieldChangeCallback}:
 * the binding bulk-reloads `pageStore` from {@link YjsDocument.getCanvasPageList}
 * — the merged snapshot — so a simultaneous MCP+author page add/rename/reorder
 * can't clobber, and the merge preserves each page's shapes.
 */
export type CanvasPagesChangeCallback = () => void;

/**
 * YjsDocument wraps a Y.Doc for collaborative shape editing.
 *
 * Usage:
 * ```typescript
 * const yjsDoc = new YjsDocument();
 *
 * // Subscribe to remote changes
 * yjsDoc.onShapeChange((added, updated, removed) => {
 *   // Update local store
 * });
 *
 * // Apply local changes
 * yjsDoc.setShape(shape);
 * yjsDoc.deleteShape(shapeId);
 *
 * // Get the Y.Doc for sync providers
 * const doc = yjsDoc.getDoc();
 * ```
 */
export class YjsDocument {
  private doc: Y.Doc;
  // JP-340: shapes are per-page (`shapes:<id>`/`shapeOrder:<id>`). The wrapper
  // binds the active page's surface here and re-binds on a page switch
  // (`rebindActivePage`); `null` until the first bind. Mutators/readers route
  // through the bound surface and no-op / return empty when unbound.
  private activePageId: string | null = null;
  private boundShapes: Y.Map<Shape> | null = null;
  private boundShapeOrder: Y.Array<string> | null = null;
  private metadata: Y.Map<unknown>;
  // JP-89: the reference library as shared types — `references` keyed by id
  // (per-item merge, like `shapes`) + `referenceOrder` (display order). The
  // active citation style lives in `metadata` under `citationStyle`.
  private references: Y.Map<CSLItem>;
  private referenceOrder: Y.Array<string>;
  // Phase 3b: the document field library as shared types — `fields` keyed by
  // name (per-item merge, like `references`) + `fieldOrder` (display order).
  private fields: Y.Map<Field>;
  private fieldOrder: Y.Array<string>;
  // JP-339: the prose page LIST as shared types — `prosePages` keyed by id
  // (per-item merge, like `fields`) + `prosePageOrder` (tab order). Page content
  // is NOT here — it stays in the per-page `prose:<id>` fragments.
  private prosePages: Y.Map<ProsePageMeta>;
  private prosePageOrder: Y.Array<string>;
  // JP-339: the canvas page LIST as shared types — `canvasPages` keyed by id
  // (per-item merge, like `fields`) + `canvasPageOrder` (tab order). Page shapes
  // are NOT here — each page's shapes live in their own `shapes:<id>` surface.
  private canvasPages: Y.Map<CanvasPageMeta>;
  private canvasPageOrder: Y.Array<string>;

  private shapeChangeCallbacks: Set<ShapeChangeCallback> = new Set();
  private orderChangeCallbacks: Set<OrderChangeCallback> = new Set();
  private metadataChangeCallbacks: Set<MetadataChangeCallback> = new Set();
  private referenceChangeCallbacks: Set<ReferenceChangeCallback> = new Set();
  private fieldChangeCallbacks: Set<FieldChangeCallback> = new Set();
  private prosePagesChangeCallbacks: Set<ProsePagesChangeCallback> = new Set();
  private canvasPagesChangeCallbacks: Set<CanvasPagesChangeCallback> = new Set();

  private isLocalUpdate = false;

  /**
   * Per-user collab undo/redo (JP-402). Owns a per-page Yjs `UndoManager` filtered
   * to this document's local-edit origin (`this`); re-pointed on every
   * `rebindActivePage`. See {@link CanvasUndoController}.
   */
  private readonly undoController = new CanvasUndoController();

  constructor() {
    // NOTE (JP-172): the Y.Doc clientID is intentionally left as Yjs's random
    // per-instance default. An earlier version pinned it deterministically to
    // hash(docId) so every client on a doc shared one clientID — which is
    // backwards for Yjs: sequence-type item IDs are (clientID, clock) tuples,
    // so colliding clientIDs corrupt ordering/dedup, and two users overwrite
    // each other's awareness. The bug was masked while the doc was ephemeral
    // (fresh clocks each session, relay-mediated) but surfaces hard with
    // persistence (y-indexeddb resumes a clock that, under a shared clientID,
    // makes peers skip each other's updates). Document identity belongs to the
    // provider room (relay docId), never the clientID.
    this.doc = new Y.Doc();

    // Initialize shared types. Shape surfaces are per-page and bound lazily via
    // `rebindActivePage` (JP-340), so none are created/observed here.
    this.metadata = this.doc.getMap('metadata');
    this.references = this.doc.getMap('references');
    this.referenceOrder = this.doc.getArray('referenceOrder');
    this.fields = this.doc.getMap('fields');
    this.fieldOrder = this.doc.getArray('fieldOrder');
    this.prosePages = this.doc.getMap('prosePages');
    this.prosePageOrder = this.doc.getArray('prosePageOrder');
    this.canvasPages = this.doc.getMap('canvasPages');
    this.canvasPageOrder = this.doc.getArray('canvasPageOrder');

    // Set up observers
    this.setupObservers();
  }

  /**
   * Get the underlying Y.Doc for use with sync providers.
   */
  getDoc(): Y.Doc {
    return this.doc;
  }

  // ============ Per-page shape binding (JP-340) ============

  /** The `shapes:<pageId>` Y.Map for a page (created on first access). */
  private shapesMapFor(pageId: string): Y.Map<Shape> {
    return this.doc.getMap<Shape>(`shapes:${pageId}`);
  }

  /** The `shapeOrder:<pageId>` Y.Array for a page (created on first access). */
  private shapeOrderArrFor(pageId: string): Y.Array<string> {
    return this.doc.getArray<string>(`shapeOrder:${pageId}`);
  }

  /**
   * Bind the active page's shape surface (`shapes:<pageId>`/`shapeOrder:<pageId>`)
   * as the one this wrapper's mutators/readers/observers act on — re-binding from
   * the previous page (unobserve old → observe new), like the prose editor
   * binding one `prose:<id>` fragment. Idempotent for the same page.
   *
   * Returns the bound page's current snapshot (read straight out of the
   * already-merged Y.Doc) so the caller can load it into the render surface
   * (`documentStore`) under `remote-apply` provenance — this is what makes
   * switching to a remotely-created/edited page render its shapes live (A2).
   */
  rebindActivePage(pageId: string): { shapes: Shape[]; order: string[] } {
    if (this.activePageId !== pageId || !this.boundShapes) {
      if (this.boundShapes) this.boundShapes.unobserve(this.handleShapeChange);
      if (this.boundShapeOrder) this.boundShapeOrder.unobserve(this.handleOrderChange);
      this.activePageId = pageId;
      this.boundShapes = this.shapesMapFor(pageId);
      this.boundShapeOrder = this.shapeOrderArrFor(pageId);
      this.boundShapes.observe(this.handleShapeChange);
      this.boundShapeOrder.observe(this.handleOrderChange);
    }
    // JP-402: re-point the per-page undo controller at this page's surface, so
    // undo/redo act on the page the user is editing.
    if (this.boundShapes && this.boundShapeOrder) {
      this.undoController.setActivePage(pageId, this.boundShapes, this.boundShapeOrder, this);
    }
    return {
      shapes: Array.from(this.getAllShapes().values()),
      order: this.getShapeOrder(),
    };
  }

  // ============ Canvas undo/redo (JP-402) ============

  /** Undo this user's last tracked canvas edit on the active page. */
  undo(): void {
    this.undoController.undo();
  }

  /** Redo this user's last undone canvas edit on the active page. */
  redo(): void {
    this.undoController.redo();
  }

  /** Whether an undo is available on the active page. */
  canUndo(): boolean {
    return this.undoController.canUndo();
  }

  /** Whether a redo is available on the active page. */
  canRedo(): boolean {
    return this.undoController.canRedo();
  }

  /**
   * Close the current undo step (action anchor) — called from the `pushHistory`
   * funnel so each discrete action is its own undo step.
   */
  closeUndoStep(): void {
    this.undoController.closeStep();
  }

  /**
   * Drop the active page's undo/redo history (shapes untouched). Called once the
   * adopted/seeded Y.Doc is the established baseline, so the user can't undo into an
   * empty/seed document.
   */
  clearUndoHistory(): void {
    this.undoController.clearActive();
  }

  /** Subscribe to undo/redo stack changes (for button reactivity). */
  onUndoStackChange(cb: () => void): () => void {
    return this.undoController.onStackChange(cb);
  }

  /** The shapes on `pageId` (its own surface), regardless of the bound page. */
  getShapesForPage(pageId: string): Shape[] {
    const result: Shape[] = [];
    this.shapesMapFor(pageId).forEach((shape) => result.push(shape));
    return result;
  }

  /** The z-order on `pageId` (its own surface), regardless of the bound page. */
  getShapeOrderForPage(pageId: string): string[] {
    return this.shapeOrderArrFor(pageId).toArray();
  }

  /**
   * Whether ANY page in the Y.Doc carries shapes (scans every `shapes:<id>`
   * root). The adopt path uses this — across pages, not just the active one —
   * to decide whether the Y.Doc holds authoritative content to adopt.
   */
  hasAnyShapes(): boolean {
    for (const [name] of this.doc.share) {
      if (name.startsWith('shapes:') && this.doc.getMap(name).size > 0) {
        return true;
      }
    }
    return false;
  }

  // ============ Prose (CRDT-native, JP-193) ============

  /**
   * The Y.XmlFragment backing a prose page, matching the field the live
   * `CollaborativeProseEditor` binds (`prose:<pageId>`) — so a headless write
   * here is reflected by a mounted editor, and vice versa.
   */
  private proseFragment(pageId: string): Y.XmlFragment {
    return this.doc.getXmlFragment(`prose:${pageId}`);
  }

  /**
   * Replace a prose page's content with `docJSON` (a ProseMirror *doc* node — the
   * shape `editor.getJSON()` returns) as a minimal, merge-safe CRDT diff, never a
   * wholesale fragment wipe. Built with the registered editor schema so the
   * result is structurally identical to a typed edit. Headless — needs no
   * mounted editor; a bound editor live-reflects the change via y-prosemirror.
   */
  setProse(pageId: string, docJSON: JSONContent): void {
    const schema = getProseSchema();
    const node = schema.nodeFromJSON(docJSON);
    const fragment = this.proseFragment(pageId);
    this.doc.transact(() => {
      updateYFragment(this.doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
    });
  }

  /**
   * Append `docJSON`'s top-level blocks to a prose page, preserving existing
   * content — the merge-safe injector path (never clobbers what's there).
   */
  appendProse(pageId: string, docJSON: JSONContent): void {
    const schema = getProseSchema();
    const fragment = this.proseFragment(pageId);
    const current = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON() as {
      content?: unknown[];
    };
    const merged: JSONContent = {
      type: 'doc',
      content: [...(current.content ?? []), ...(docJSON.content ?? [])] as JSONContent[],
    };
    const node = schema.nodeFromJSON(merged);
    this.doc.transact(() => {
      updateYFragment(this.doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
    });
  }

  /**
   * JP-338 self-heal: if a prose page's fragment is the body concatenated
   * **exactly twice** — the write-vs-hydrate CRDT-lineage-merge signature (a
   * client cached a live write `L` while the relay later re-seeded the
   * deterministic `D`) — delete the duplicate half. The delete is a normal CRDT
   * op, so it propagates to the relay + peers and heals everyone. Returns whether
   * it collapsed.
   *
   * **Strict** (mirrors the relay's `collapse_doubled_prose`): only an exact
   * full-fragment 2× repetition with **≥2 blocks per half** (so two identical
   * single paragraphs — plausibly intentional — are never touched). Runs once
   * after the initial sync settles, when a poisoned `y-indexeddb` lineage has
   * merged with the relay's.
   */
  healDoubledProse(pageId: string): boolean {
    const fragment = this.proseFragment(pageId);
    const n = fragment.length;
    if (n < 4 || n % 2 !== 0) return false;
    const half = n / 2;
    const kids = fragment.toArray();
    const firstHalf = kids.slice(0, half).map((k) => k.toString()).join('');
    const secondHalf = kids.slice(half).map((k) => k.toString()).join('');
    if (!firstHalf || firstHalf !== secondHalf) return false;
    this.doc.transact(() => fragment.delete(half, half));
    return true;
  }

  // ============ Local to Remote Sync ============

  /**
   * Set or update a shape on the bound active page (local change -> broadcast to
   * peers). No-op when no page is bound (JP-340).
   */
  setShape(shape: Shape): void {
    if (!this.boundShapes) return;
    this.withLocalUpdate(() => {
      // Clone the shape to avoid reference issues
      this.boundShapes!.set(shape.id, JSON.parse(JSON.stringify(shape)));
    });
  }

  /**
   * Set multiple shapes on the bound active page in a single transaction.
   */
  setShapes(shapes: Shape[]): void {
    if (!this.boundShapes) return;
    this.withLocalUpdate(() => {
      for (const shape of shapes) {
        this.boundShapes!.set(shape.id, JSON.parse(JSON.stringify(shape)));
      }
    });
  }

  /**
   * Delete a shape by ID from the bound active page.
   */
  deleteShape(shapeId: string): void {
    if (!this.boundShapes) return;
    this.withLocalUpdate(() => {
      this.boundShapes!.delete(shapeId);
    });
  }

  /**
   * Delete multiple shapes by ID from the bound active page.
   */
  deleteShapes(shapeIds: string[]): void {
    if (!this.boundShapes) return;
    this.withLocalUpdate(() => {
      for (const id of shapeIds) {
        this.boundShapes!.delete(id);
      }
    });
  }

  /**
   * Update the bound active page's shape order (z-index).
   */
  setShapeOrder(order: string[]): void {
    if (!this.boundShapeOrder) return;
    this.withLocalUpdate(() => {
      // Clear and repopulate the array
      this.boundShapeOrder!.delete(0, this.boundShapeOrder!.length);
      this.boundShapeOrder!.push(order);
    });
  }

  /**
   * Update document metadata.
   */
  setMetadata(meta: Partial<YjsDocumentMetadata>): void {
    this.withLocalUpdate(() => {
      for (const [key, value] of Object.entries(meta)) {
        this.metadata.set(key, value);
      }
    });
  }

  // ============ References (JP-89) — local to remote ============

  /**
   * Set or update one reference (local change → broadcast to peers). INVARIANT A:
   * a strictly per-item `set` (+ append the id to `referenceOrder` if new) — never
   * a whole-map rewrite, so a concurrent writer's not-yet-observed ref can't be
   * wiped.
   */
  setReference(item: CSLItem): void {
    this.withLocalUpdate(() => {
      this.references.set(item.id, JSON.parse(JSON.stringify(item)));
      if (!this.referenceOrder.toArray().includes(item.id)) {
        this.referenceOrder.push([item.id]);
      }
    });
  }

  /**
   * Delete a reference by id (per-item `delete` + drop it from `referenceOrder`).
   */
  deleteReference(id: string): void {
    this.withLocalUpdate(() => {
      this.references.delete(id);
      const idx = this.referenceOrder.toArray().indexOf(id);
      if (idx >= 0) this.referenceOrder.delete(idx, 1);
    });
  }

  /**
   * Set the active citation style (stored in `metadata.citationStyle`).
   */
  setReferenceStyle(style: CitationStyle): void {
    this.withLocalUpdate(() => {
      this.metadata.set('citationStyle', style);
    });
  }

  /**
   * The merged reference library as a {@link ReferenceLibrary} snapshot —
   * `items` (id → CSLItem), a de-duplicated `itemOrder` (filtered to existing
   * items, with any unordered items appended), and the active `style`. The
   * binding bulk-reloads `referenceStore` from this on any remote change.
   */
  getReferenceLibrary(): ReferenceLibrary {
    const items: Record<string, CSLItem> = {};
    this.references.forEach((item, id) => {
      items[id] = item;
    });
    const itemOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of this.referenceOrder.toArray()) {
      if (items[id] && !seen.has(id)) {
        itemOrder.push(id);
        seen.add(id);
      }
    }
    for (const id of Object.keys(items)) {
      if (!seen.has(id)) {
        itemOrder.push(id);
        seen.add(id);
      }
    }
    const rawStyle = this.metadata.get('citationStyle');
    const lib: ReferenceLibrary = { items, itemOrder };
    if (typeof rawStyle === 'string') lib.style = rawStyle as CitationStyle;
    return lib;
  }

  // ============ Fields (Phase 3b) — local to remote ============

  /**
   * Set or update one field (local change → broadcast to peers). INVARIANT A:
   * a strictly per-item `set` (keyed by name) + append the name to `fieldOrder`
   * if new — never a whole-map rewrite, so a concurrent writer's not-yet-observed
   * field can't be wiped. Re-setting an existing name is an in-place value update
   * (LWW), with no duplicate `fieldOrder` entry — i.e. "edit a value."
   */
  setField(field: Field): void {
    this.withLocalUpdate(() => {
      this.fields.set(field.name, JSON.parse(JSON.stringify(field)));
      if (!this.fieldOrder.toArray().includes(field.name)) {
        this.fieldOrder.push([field.name]);
      }
    });
  }

  /**
   * Delete a field by name (per-item `delete` + drop it from `fieldOrder`).
   */
  deleteField(name: string): void {
    this.withLocalUpdate(() => {
      this.fields.delete(name);
      const idx = this.fieldOrder.toArray().indexOf(name);
      if (idx >= 0) this.fieldOrder.delete(idx, 1);
    });
  }

  /**
   * The merged field library as a {@link FieldLibrary} snapshot — `fields`
   * (name → Field) + a de-duplicated `order` (filtered to existing fields, with
   * any unordered fields appended). The binding bulk-reloads `fieldStore` from
   * this on any remote change. Mirrors {@link getReferenceLibrary}.
   */
  getFieldLibrary(): FieldLibrary {
    const fields: Record<string, Field> = {};
    this.fields.forEach((field, name) => {
      fields[name] = field;
    });
    const order: string[] = [];
    const seen = new Set<string>();
    for (const name of this.fieldOrder.toArray()) {
      if (fields[name] && !seen.has(name)) {
        order.push(name);
        seen.add(name);
      }
    }
    for (const name of Object.keys(fields)) {
      if (!seen.has(name)) {
        order.push(name);
        seen.add(name);
      }
    }
    return { fields, order };
  }

  // ============ Prose page-list (JP-339) — local to remote ============

  /**
   * Set or update one prose page's metadata (local change → broadcast to peers).
   * INVARIANT A: a strictly per-item `set` (keyed by id) + append the id to
   * `prosePageOrder` if new — never a whole-map rewrite, so a concurrent
   * writer's not-yet-observed page can't be wiped. Re-setting an existing id is
   * an in-place value update (LWW: rename/recolor/reorder) with no duplicate
   * order entry. Content is untouched — it lives in the `prose:<id>` fragment.
   */
  setProsePage(meta: ProsePageMeta): void {
    this.withLocalUpdate(() => {
      this.prosePages.set(meta.id, JSON.parse(JSON.stringify(meta)));
      if (!this.prosePageOrder.toArray().includes(meta.id)) {
        this.prosePageOrder.push([meta.id]);
      }
    });
  }

  /**
   * Replace `prosePageOrder` with `order` (clear + repush, one txn) — the tab
   * reorder op. Mirrors {@link setShapeOrder}: ordering is driven by this
   * Y.Array (not the meta `order` field), so a reorder rewrites it wholesale.
   * The merged {@link getProsePageList} filters to existing pages and appends
   * any unordered ones, so a concurrent add racing this rewrite is never lost,
   * only ordered last.
   */
  setProsePageOrder(order: string[]): void {
    this.withLocalUpdate(() => {
      this.prosePageOrder.delete(0, this.prosePageOrder.length);
      this.prosePageOrder.push(order);
    });
  }

  /**
   * Delete a prose page by id (per-item `delete` + drop it from
   * `prosePageOrder`). The page's `prose:<id>` fragment is cleared separately.
   */
  deleteProsePage(id: string): void {
    this.withLocalUpdate(() => {
      this.prosePages.delete(id);
      const idx = this.prosePageOrder.toArray().indexOf(id);
      if (idx >= 0) this.prosePageOrder.delete(idx, 1);
    });
  }

  /**
   * The merged prose page-list snapshot — `pages` (id → meta) + a de-duplicated
   * `pageOrder` (filtered to existing pages, with any unordered pages appended).
   * The binding bulk-reloads `richTextPagesStore` from this on any remote
   * change. Mirrors {@link getReferenceLibrary} / {@link getFieldLibrary}.
   */
  getProsePageList(): ProsePageList {
    const pages: Record<string, ProsePageMeta> = {};
    this.prosePages.forEach((meta, id) => {
      pages[id] = meta;
    });
    const pageOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of this.prosePageOrder.toArray()) {
      if (pages[id] && !seen.has(id)) {
        pageOrder.push(id);
        seen.add(id);
      }
    }
    for (const id of Object.keys(pages)) {
      if (!seen.has(id)) {
        pageOrder.push(id);
        seen.add(id);
      }
    }
    return { pages, pageOrder };
  }

  // ============ Canvas page-list (JP-339) — local to remote ============

  /**
   * Set or update one canvas page's metadata (local change → broadcast to
   * peers). INVARIANT A: a strictly per-item `set` (keyed by id) + append the id
   * to `canvasPageOrder` if new — never a whole-map rewrite, so a concurrent
   * writer's not-yet-observed page can't be wiped. Shapes are untouched — only
   * the active page's shapes live in the Y.Doc `shapes` surface.
   */
  setCanvasPage(meta: CanvasPageMeta): void {
    this.withLocalUpdate(() => {
      this.canvasPages.set(meta.id, JSON.parse(JSON.stringify(meta)));
      if (!this.canvasPageOrder.toArray().includes(meta.id)) {
        this.canvasPageOrder.push([meta.id]);
      }
    });
  }

  /**
   * Replace `canvasPageOrder` with `order` (clear + repush, one txn) — the tab
   * reorder op. Mirrors {@link setShapeOrder}; ordering is driven by this Y.Array
   * (not a numeric field). The merged {@link getCanvasPageList} filters to
   * existing pages and appends unordered ones, so a concurrent add racing this
   * rewrite is never lost, only ordered last.
   */
  setCanvasPageOrder(order: string[]): void {
    this.withLocalUpdate(() => {
      this.canvasPageOrder.delete(0, this.canvasPageOrder.length);
      this.canvasPageOrder.push(order);
    });
  }

  /**
   * Delete a canvas page by id (per-item `delete` + drop it from
   * `canvasPageOrder`).
   */
  deleteCanvasPage(id: string): void {
    this.withLocalUpdate(() => {
      this.canvasPages.delete(id);
      const idx = this.canvasPageOrder.toArray().indexOf(id);
      if (idx >= 0) this.canvasPageOrder.delete(idx, 1);
    });
  }

  /**
   * The merged canvas page-list snapshot — `pages` (id → meta) + a de-duplicated
   * `pageOrder` (filtered to existing pages, with any unordered pages appended).
   * Mirrors {@link getFieldLibrary}.
   */
  getCanvasPageList(): CanvasPageList {
    const pages: Record<string, CanvasPageMeta> = {};
    this.canvasPages.forEach((meta, id) => {
      pages[id] = meta;
    });
    const pageOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of this.canvasPageOrder.toArray()) {
      if (pages[id] && !seen.has(id)) {
        pageOrder.push(id);
        seen.add(id);
      }
    }
    for (const id of Object.keys(pages)) {
      if (!seen.has(id)) {
        pageOrder.push(id);
        seen.add(id);
      }
    }
    return { pages, pageOrder };
  }

  // ============ Remote to Local Sync ============

  /**
   * Subscribe to shape changes from remote peers.
   */
  onShapeChange(callback: ShapeChangeCallback): () => void {
    this.shapeChangeCallbacks.add(callback);
    return () => this.shapeChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to shape order changes from remote peers.
   */
  onOrderChange(callback: OrderChangeCallback): () => void {
    this.orderChangeCallbacks.add(callback);
    return () => this.orderChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to metadata changes from remote peers.
   */
  onMetadataChange(callback: MetadataChangeCallback): () => void {
    this.metadataChangeCallbacks.add(callback);
    return () => this.metadataChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to reference-library changes from remote peers (JP-89). Fires on
   * any `references` / `referenceOrder` / `metadata.citationStyle` change.
   */
  onReferenceChange(callback: ReferenceChangeCallback): () => void {
    this.referenceChangeCallbacks.add(callback);
    return () => this.referenceChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to field-library changes from remote peers (Phase 3b). Fires on
   * any `fields` / `fieldOrder` change.
   */
  onFieldChange(callback: FieldChangeCallback): () => void {
    this.fieldChangeCallbacks.add(callback);
    return () => this.fieldChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to prose page-list changes from remote peers (JP-339). Fires on
   * any `prosePages` / `prosePageOrder` change.
   */
  onProsePagesChange(callback: ProsePagesChangeCallback): () => void {
    this.prosePagesChangeCallbacks.add(callback);
    return () => this.prosePagesChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to canvas page-list changes from remote peers (JP-339). Fires on
   * any `canvasPages` / `canvasPageOrder` change.
   */
  onCanvasPagesChange(callback: CanvasPagesChangeCallback): () => void {
    this.canvasPagesChangeCallbacks.add(callback);
    return () => this.canvasPagesChangeCallbacks.delete(callback);
  }

  // ============ State Access ============

  /**
   * Get all shapes on the bound active page as a Map. Empty when no page is
   * bound.
   */
  getAllShapes(): Map<string, Shape> {
    const result = new Map<string, Shape>();
    this.boundShapes?.forEach((shape, id) => {
      result.set(id, shape);
    });
    return result;
  }

  /**
   * Get a shape by ID from the bound active page.
   */
  getShape(id: string): Shape | undefined {
    return this.boundShapes?.get(id);
  }

  /**
   * Get the bound active page's shape order array. Empty when no page is bound.
   */
  getShapeOrder(): string[] {
    return this.boundShapeOrder?.toArray() ?? [];
  }

  /**
   * The document name from the `metadata` map (stored under `title`), or
   * `undefined` if unset. Unlike {@link getMetadata}, this does NOT substitute
   * a default — callers applying a remote rename must distinguish "no name in
   * the Y.Doc" from a doc legitimately named "Untitled", or they'd clobber the
   * local name with the placeholder.
   */
  getName(): string | undefined {
    const title = this.metadata.get('title');
    return typeof title === 'string' ? title : undefined;
  }

  /**
   * Get document metadata.
   */
  getMetadata(): YjsDocumentMetadata {
    return {
      title: (this.metadata.get('title') as string) ?? 'Untitled',
      createdAt: (this.metadata.get('createdAt') as number) ?? Date.now(),
      updatedAt: (this.metadata.get('updatedAt') as number) ?? Date.now(),
    };
  }

  // ============ Bulk Operations ============

  /**
   * Initialize the document with existing shapes.
   *
   * ⚠️ DANGER (JP-179): this calls `shapes.clear()` on the Y.Doc. If the doc is
   * attached to a provider, that clear broadcasts a CRDT DELETION that wipes
   * every peer's shapes (proven in `seedClobber.proof.test.ts`). Only call this
   * on a brand-new, NEVER-synced, provider-less Y.Doc. The collab adopt path
   * must never seed a connected/synced doc — use "adopt-to-empty" instead.
   */
  initializeFromState(
    shapes: Shape[],
    order: string[],
    metadata?: Partial<YjsDocumentMetadata>
  ): void {
    if (!this.boundShapes || !this.boundShapeOrder) return;
    this.doc.transact(() => {
      // Clear existing state
      this.boundShapes!.clear();
      this.boundShapeOrder!.delete(0, this.boundShapeOrder!.length);

      // Set shapes
      for (const shape of shapes) {
        this.boundShapes!.set(shape.id, JSON.parse(JSON.stringify(shape)));
      }

      // Set order
      this.boundShapeOrder!.push(order);

      // Set metadata
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          this.metadata.set(key, value);
        }
      }
    }, this); // Mark as local origin
  }

  /**
   * Clear the bound active page's shapes from the document.
   */
  clear(): void {
    if (!this.boundShapes || !this.boundShapeOrder) return;
    this.doc.transact(() => {
      this.boundShapes!.clear();
      this.boundShapeOrder!.delete(0, this.boundShapeOrder!.length);
    }, this);
  }

  /**
   * Destroy the document and clean up observers.
   */
  destroy(): void {
    // JP-402: tear down the per-page undo managers before the Y.Doc is destroyed.
    this.undoController.destroy();
    // Per-page shape surfaces are observed only while bound (JP-340).
    this.boundShapes?.unobserve(this.handleShapeChange);
    this.boundShapeOrder?.unobserve(this.handleOrderChange);
    this.metadata.unobserve(this.handleMetadataChange);
    this.references.unobserve(this.handleReferenceChange);
    this.referenceOrder.unobserve(this.handleReferenceChange);
    this.metadata.unobserve(this.handleReferenceMetaChange);
    this.fields.unobserve(this.handleFieldChange);
    this.fieldOrder.unobserve(this.handleFieldChange);
    this.prosePages.unobserve(this.handleProsePagesChange);
    this.prosePageOrder.unobserve(this.handleProsePagesChange);
    this.canvasPages.unobserve(this.handleCanvasPagesChange);
    this.canvasPageOrder.unobserve(this.handleCanvasPagesChange);
    this.doc.destroy();
  }

  // ============ Private Methods ============

  private setupObservers(): void {
    // Shape + order observers are attached per-page on `rebindActivePage`
    // (JP-340), not here — only the bound active page is observed.

    // Observe metadata changes
    this.metadata.observe(this.handleMetadataChange);

    // JP-89: observe reference-library changes (map + order), and citation-style
    // changes on the metadata map (a second observer — both fire independently).
    this.references.observe(this.handleReferenceChange);
    this.referenceOrder.observe(this.handleReferenceChange);
    this.metadata.observe(this.handleReferenceMetaChange);

    // Phase 3b: observe field-library changes (map + order). No metadata
    // analogue — fields carry no style/active-key.
    this.fields.observe(this.handleFieldChange);
    this.fieldOrder.observe(this.handleFieldChange);

    // JP-339: observe prose page-list changes (map + order). No metadata
    // analogue.
    this.prosePages.observe(this.handleProsePagesChange);
    this.prosePageOrder.observe(this.handleProsePagesChange);

    // JP-339: observe canvas page-list changes (map + order).
    this.canvasPages.observe(this.handleCanvasPagesChange);
    this.canvasPageOrder.observe(this.handleCanvasPagesChange);
  }

  private handleShapeChange = (event: Y.YMapEvent<Shape>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const added: Shape[] = [];
    const updated: Shape[] = [];
    const removed: string[] = [];

    // Read from the event's own target (the bound page's map) so a change is
    // always resolved against the surface it fired on.
    const map = event.target as Y.Map<Shape>;
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add') {
        const shape = map.get(key);
        if (shape) added.push(shape);
      } else if (change.action === 'update') {
        const shape = map.get(key);
        if (shape) updated.push(shape);
      } else if (change.action === 'delete') {
        removed.push(key);
      }
    });

    // Notify callbacks
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.shapeChangeCallbacks.forEach((cb) => cb(added, updated, removed));
    }
  };

  private handleOrderChange = (event: Y.YArrayEvent<string>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const order = (event.target as Y.Array<string>).toArray();
    this.orderChangeCallbacks.forEach((cb) => cb(order));
  };

  private handleMetadataChange = (event: Y.YMapEvent<unknown>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const metadata = this.getMetadata();
    this.metadataChangeCallbacks.forEach((cb) => cb(metadata));
  };

  // JP-89: a remote change to `references` or `referenceOrder` → fire the coarse
  // reference callback (the binding bulk-reloads from the merged snapshot).
  private handleReferenceChange = (
    event: Y.YMapEvent<CSLItem> | Y.YArrayEvent<string>
  ): void => {
    if (this.isLocalUpdate || event.transaction.origin === this) return;
    this.referenceChangeCallbacks.forEach((cb) => cb());
  };

  // JP-89: a remote `metadata.citationStyle` change also drives a reference
  // reload (the library snapshot includes the active style). Gated to that key so
  // an unrelated metadata edit (e.g. a rename) doesn't churn the library.
  private handleReferenceMetaChange = (event: Y.YMapEvent<unknown>): void => {
    if (this.isLocalUpdate || event.transaction.origin === this) return;
    if (event.changes.keys.has('citationStyle')) {
      this.referenceChangeCallbacks.forEach((cb) => cb());
    }
  };

  // Phase 3b: a remote change to `fields` or `fieldOrder` → fire the coarse
  // field callback (the binding bulk-reloads from the merged snapshot).
  private handleFieldChange = (
    event: Y.YMapEvent<Field> | Y.YArrayEvent<string>
  ): void => {
    if (this.isLocalUpdate || event.transaction.origin === this) return;
    this.fieldChangeCallbacks.forEach((cb) => cb());
  };

  // JP-339: a remote change to `prosePages` or `prosePageOrder` → fire the
  // coarse page-list callback (the binding bulk-reloads from the merged
  // snapshot, preserving each page's already-synced content).
  private handleProsePagesChange = (
    event: Y.YMapEvent<ProsePageMeta> | Y.YArrayEvent<string>
  ): void => {
    if (this.isLocalUpdate || event.transaction.origin === this) return;
    this.prosePagesChangeCallbacks.forEach((cb) => cb());
  };

  // JP-339: a remote change to `canvasPages` or `canvasPageOrder` → fire the
  // coarse page-list callback (the binding bulk-reloads from the merged snapshot,
  // preserving each page's shapes).
  private handleCanvasPagesChange = (
    event: Y.YMapEvent<CanvasPageMeta> | Y.YArrayEvent<string>
  ): void => {
    if (this.isLocalUpdate || event.transaction.origin === this) return;
    this.canvasPagesChangeCallbacks.forEach((cb) => cb());
  };

  /**
   * Execute a function within a local update context.
   * This prevents the observer from re-notifying about our own changes.
   */
  private withLocalUpdate(fn: () => void): void {
    this.isLocalUpdate = true;
    this.doc.transact(() => {
      fn();
    }, this); // Mark transaction origin
    this.isLocalUpdate = false;
  }
}

export default YjsDocument;
