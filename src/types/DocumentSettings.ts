/**
 * Per-document settings (DSK-246), such as the document font.
 *
 * Every build carries the whole object, keys it doesn't know included: the
 * local save, the collab `settings` map and the relay's flatten all copy it
 * wholesale. So a new setting needs no reader release of its own. Its value
 * must still degrade gracefully on a build that doesn't know it (a font, for
 * example, is a CSS font-family list ending in a generic family).
 */

/** A JSON value, which is all a setting may hold. */
export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [key: string]: SettingValue };

/** Setting name → value. */
export type DocumentSettings = Record<string, SettingValue>;

/**
 * Settings from untrusted input (a stored document, a peer's Y.Doc): a plain
 * object of JSON values, deep-copied. Anything else reads as no settings.
 */
export function normalizeDocumentSettings(raw: unknown): DocumentSettings {
  if (raw === null || typeof raw !== 'object') return {};
  try {
    const copy: unknown = JSON.parse(JSON.stringify(raw));
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) return {};
    return copy as DocumentSettings;
  } catch {
    // A cycle or a BigInt: not JSON, so not settings.
    return {};
  }
}
