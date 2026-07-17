/**
 * PageMirror — provenance for a prose page that mirrors an external resource
 * (JP-415; Notion is the first provider). A page carrying this metadata is an
 * inbound content mirror: read-only in the editor, refreshed from the source
 * on demand, and detachable into a normal page (which simply clears this).
 *
 * Provider-agnostic by design: the editor renders whatever `provider` id the
 * cloud control plane reports — all provider-specific logic (OAuth, search,
 * block transforms) lives server-side. Lives in `types/` (a leaf module) so
 * both the store layer (`RichTextPage`) and the collaboration layer
 * (`ProsePageMeta`) can carry it without an import cycle.
 */

export interface PageMirrorMeta {
  /** Connector id on the control plane, e.g. 'notion'. */
  provider: string;
  /** Provider-native resource id (what the fetch endpoint expects). */
  externalId: string;
  /** Canonical URL of the source on the provider (the "open in <provider>" link). */
  url?: string;
  /** Emoji icon of the source, when the provider has one (Notion page emoji). */
  iconEmoji?: string;
  /** Provider's version stamp at last sync (e.g. Notion `last_edited_time`). */
  version?: string;
  /** Local wall-clock ms of the last successful sync. */
  syncedAt: number;
}

/** Field-wise equality — the collab meta-diff uses this to decide whether a
 *  page's mirror state changed (object identity churns on every refresh). */
export function pageMirrorEquals(a: PageMirrorMeta | undefined, b: PageMirrorMeta | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.externalId === b.externalId &&
    a.url === b.url &&
    a.iconEmoji === b.iconEmoji &&
    a.version === b.version &&
    a.syncedAt === b.syncedAt
  );
}
