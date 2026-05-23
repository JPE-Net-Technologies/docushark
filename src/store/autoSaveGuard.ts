/**
 * Shared guard for suppressing the `useAutoSave` store subscribers
 * during operations that mutate the document/page/richText stores as a
 * side-effect of saving or loading (not as a real user edit).
 *
 * Without this, loading a document at boot or after reattach would fire
 * the subscribers, mark dirty, and trigger an autosave on the next
 * debounce tick — pushing the just-loaded content back to the relay as
 * a fresh version every time the app starts.
 */

let depth = 0;

export function isAutoSaveSuppressed(): boolean {
  return depth > 0;
}

/**
 * Run `fn` with autosave subscribers suppressed. Nestable — only the
 * outermost caller flips the flag back off.
 */
export function withAutoSaveSuppressed<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

// Registered by useAutoSave on first install. Lives here (not in the
// hook module) so persistenceStore can import the flush helper without
// creating a hook ⇄ store circular import.
let flushImpl: (() => void) | null = null;

export function registerAutoSaveFlush(fn: () => void): void {
  flushImpl = fn;
}

/**
 * Flush any pending debounced autosave. Safe to call before the hook
 * has installed — no-op until it has.
 */
export function flushAutoSaveNow(): void {
  flushImpl?.();
}
