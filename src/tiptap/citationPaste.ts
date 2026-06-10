/**
 * Paste-a-DOI-to-cite (JP-89 delight slice).
 *
 * When the clipboard holds a single bare DOI (or a `doi.org` URL), pasting it
 * into prose resolves the DOI to a reference, adds it to the document's library
 * (dedup-safe), and turns the pasted text into an inline citation — the fast
 * "I have a DOI, cite it" path.
 *
 * The handler is synchronous (ProseMirror `handlePaste` must return immediately)
 * so it inserts the DOI text at the caret right away — nothing is ever lost —
 * then resolves asynchronously and *replaces that exact text* with a citation
 * once the lookup returns. If the user edited the pasted text meanwhile, the
 * replace is skipped (the reference is still added to the library), so the async
 * write can never clobber unrelated edits.
 *
 * Wired into both prose editors via `editorProps.handlePaste`.
 */

import type { EditorView } from '@tiptap/pm/view';
import { normalizeDoi, resolveDoi } from '../services/citations/ingest';
import { importReferences } from '../services/citations/referenceImport';
import { referencePreview } from '../services/citations/preview';
import { useReferenceStore } from '../store/referenceStore';
import { useNotificationStore } from '../store/notificationStore';

/** True when `text` is a single token that resolves to a bare DOI (`10.x/y`). */
export function isBareDoi(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false; // single token only
  return /^10\.\d{4,9}\/\S+$/.test(normalizeDoi(trimmed));
}

/** Find an existing library entry's id by DOI (case-insensitive). */
function refIdForDoi(doi: string): string | undefined {
  const norm = doi.trim().toLowerCase();
  return useReferenceStore
    .getState()
    .listReferences()
    .find((r) => typeof r.DOI === 'string' && r.DOI.trim().toLowerCase() === norm)?.id;
}

async function resolveAndCite(view: EditorView, bareDoi: string, from: number, to: number): Promise<void> {
  const notify = useNotificationStore.getState();
  const result = await resolveDoi(bareDoi);
  if (result.report.errors.length > 0 || result.items.length === 0) {
    notify.error(result.report.errors[0] ?? `Couldn't resolve DOI ${bareDoi}`);
    return; // leave the pasted DOI text untouched
  }

  const resolved = result.items[0]!;
  importReferences([resolved]); // dedup-safe upsert into the library
  const refId = refIdForDoi(resolved.DOI ?? bareDoi) ?? resolved.id;
  const label = referencePreview(resolved);

  const citation = view.state.schema.nodes['citationInline'];
  // Replace the inserted DOI text with a citation only if it's still exactly
  // there — otherwise a subsequent edit would be clobbered; just keep the ref.
  const untouched =
    !!citation &&
    to <= view.state.doc.content.size &&
    view.state.doc.textBetween(from, to) === bareDoi;

  if (untouched) {
    const node = citation.create({ refId, locator: null });
    view.dispatch(view.state.tr.replaceWith(from, to, node));
    notify.success(`Cited ${label}`);
  } else {
    notify.success(`Added ${label} to your references`);
  }
}

/**
 * ProseMirror `handlePaste` hook: consume a bare-DOI paste and resolve→cite it.
 * Returns false for any other paste so normal paste handling proceeds.
 */
export function handleCitationDoiPaste(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!isBareDoi(text)) return false;

  const bareDoi = normalizeDoi(text.trim());
  // Insert the bare DOI text now (replacing any selection) so the position is
  // exact and the content is never lost if resolution fails.
  const { from: selFrom, to: selTo } = view.state.selection;
  view.dispatch(view.state.tr.insertText(bareDoi, selFrom, selTo));
  const from = selFrom;
  const to = selFrom + bareDoi.length;

  useNotificationStore.getState().info(`Resolving DOI ${bareDoi}…`, { duration: 2000 });
  void resolveAndCite(view, bareDoi, from, to);
  return true;
}
