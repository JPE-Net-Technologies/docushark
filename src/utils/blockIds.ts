/**
 * Durable block-id primitives (JP-432 Pillar C) — dependency-free on purpose.
 *
 * The document migration (`src/migrations/documentMigrations.ts`) runs in the
 * main bundle's load path and must NOT drag the lazily-loaded Tiptap stack in,
 * so the mint and the id-bearing type list live here; `BlockIdExtension`
 * (the prose chunk) re-exports them.
 */

import { nanoid } from 'nanoid';

/**
 * Node types that carry a durable block id. Mirrors the relay's `BLOCK_ATTRS`
 * id rows and `prose_block::TEXT_LEAVES` — the schema contract test pins the
 * editor side.
 */
export const BLOCK_ID_TYPES = ['heading', 'paragraph', 'codeBlock'];

/** Mint a fresh block id (`blk-` + nanoid, charset `[A-Za-z0-9_-]`). */
export const mintBlockId = (): string => `blk-${nanoid(10)}`;
