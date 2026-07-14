/**
 * Durable block ids (JP-432 Pillar C).
 *
 * Declares a global `id` attribute on the addressable text-leaf blocks and
 * mints `blk-<nanoid>` values for id-less blocks on locally-authored edits.
 * The id is the durable half of MCP block addressing (the text anchor is the
 * ephemeral half) and the drift-proof target for heading links
 * (`docushark://heading/<pageId>/id:<blockId>`).
 *
 * Why schema-declared: y-prosemirror removes any Y.XmlElement attribute that
 * is not in the local ProseMirror schema on the next reconciliation of that
 * element (sync-plugin `updateYFragment`), so an undeclared id would be
 * stripped doc-wide by the first stale client. Declaring it (with a `null`
 * default) makes the attribute schema-known everywhere this schema is used —
 * the local editor, the collab editor, previews, PDF export, and the headless
 * collab write path all build from `sharedProseExtensions`.
 *
 * Why minting is transaction-filtered: only genuinely local edits sweep-mint.
 * Remote collab transactions (`ySyncPluginKey` meta), projection write-backs
 * (`PROSE_PROJECTION_META`), programmatic silent loads (Tiptap sets
 * `preventUpdate` on `setContent(…, emitUpdate=false)` — the document-load
 * path), and `addToHistory: false` derived writes never mint — so opening or
 * merely viewing a document cannot dirty it, and no client sweep-mints just
 * by joining a collab session. An old document converges on its first local
 * edit (the sweep is the lazy in-CRDT migration for collab docs the
 * stored-HTML migration cannot reach).
 *
 * Must mirror the relay's `BLOCK_ATTRS` id rows + `TEXT_LEAVES`
 * (`relay/src/sync/prose_schema.rs`, `prose_block.rs`) — the schema contract
 * test pins this.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';
import { isProjectionTransaction } from './proseProjection';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';
import { BLOCK_ID_TYPES, mintBlockId } from '../utils/blockIds';

// Re-exported for consumers that already live in the prose chunk; the
// primitives live in utils/blockIds so main-bundle code (the document
// migration) can mint without dragging the Tiptap stack in.
export { BLOCK_ID_TYPES, mintBlockId };

/** Meta tag on the sweep's own transaction (re-entry / observer filter). */
export const BLOCK_ID_MINT_META = 'blockIdMint';

/** True when `tr` is a locally-authored content edit that should sweep-mint. */
function isMintableEdit(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  if (tr.getMeta(ySyncPluginKey)) return false; // remote collab update
  if (isProjectionTransaction(tr)) return false; // derived cache write-back
  if (tr.getMeta('preventUpdate') === true) return false; // silent setContent (load)
  if (tr.getMeta('addToHistory') === false) return false; // derived, not a user edit
  if (tr.getMeta(BLOCK_ID_MINT_META) === true) return false; // our own sweep
  return true;
}

const blockIdMintPluginKey = new PluginKey('blockIdMint');

function blockIdMintPlugin(): Plugin {
  return new Plugin({
    key: blockIdMintPluginKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some(isMintableEdit)) return null;
      // Belt-and-braces: never mint inside a load/new/switch window even if a
      // stray transaction slips through the meta filters above.
      if (isAutoSaveSuppressed()) return null;

      // Full-doc sweep: mint id-less blocks, re-mint later duplicates (paste /
      // copy keeps the FIRST occurrence in document order). Attribute-only
      // steps never shift positions, so collected positions stay valid.
      const seen = new Set<string>();
      let tr: Transaction | null = null;
      newState.doc.descendants((node, pos) => {
        // Containers (lists, quotes, tables) are descended through to reach
        // the id-bearing leaves inside them.
        if (!BLOCK_ID_TYPES.includes(node.type.name)) return true;
        const id = node.attrs['id'];
        if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
          seen.add(id);
          return false; // a leaf holds only inline content — skip it
        }
        tr ??= newState.tr;
        const minted = mintBlockId();
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: minted });
        seen.add(minted);
        return false;
      });
      // Assert through a const: TS can't see the closure assignment above, so
      // it still narrows `tr` to its `null` initializer here.
      const sweep = tr as Transaction | null;
      if (!sweep) return null;
      // Deliberately stays in history (no `addToHistory: false`): undoing the
      // edit that created a block removes the block and its id together.
      sweep.setMeta(BLOCK_ID_MINT_META, true);
      return sweep;
    },
  });
}

export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          id: {
            default: null,
            // Enter-split must NOT copy the id onto the new block — ids are
            // minted fresh (and the dedup sweep backstops paste duplicates).
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute('id'),
            renderHTML: (attributes) =>
              typeof attributes['id'] === 'string' && attributes['id'].length > 0
                ? { id: attributes['id'] }
                : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [blockIdMintPlugin()];
  },
});
