/**
 * Auto-save hook for automatic document persistence.
 *
 * The actual subscription/timer machinery lives at module scope so that
 * calling `useAutoSave()` from multiple components (App, toolbar, status
 * indicator) doesn't create N independent debounced timers — that bug
 * caused every user edit to fire one PUT to the relay per call site.
 */

import { useEffect, useState, useCallback } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { usePageStore } from '../store/pageStore';
import { usePersistenceStore, AUTO_SAVE_DEBOUNCE } from '../store/persistenceStore';
import { useRichTextStore } from '../store/richTextStore';
import {
  isAutoSaveSuppressed,
  withAutoSaveSuppressed,
  registerAutoSaveFlush,
} from '../store/autoSaveGuard';

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface UseAutoSaveOptions {
  enabled?: boolean;
  debounceMs?: number;
  onSave?: () => void;
  onError?: (error: Error) => void;
}

export interface UseAutoSaveResult {
  status: AutoSaveStatus;
  isDirty: boolean;
  lastSavedAt: number | null;
  saveNow: () => void;
}

// ============ Module-level singleton state ============

let installed = false;
let installedDebounceMs = AUTO_SAVE_DEBOUNCE;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let pendingSave = false;
let status: AutoSaveStatus = 'idle';
const statusListeners = new Set<() => void>();
const onSaveListeners = new Set<() => void>();
const onErrorListeners = new Set<(err: Error) => void>();

function setStatus(next: AutoSaveStatus): void {
  status = next;
  statusListeners.forEach((fn) => fn());
}

function performSave(): void {
  if (!usePersistenceStore.getState().autoSaveEnabled) return;
  try {
    setStatus('saving');
    withAutoSaveSuppressed(() => {
      usePersistenceStore.getState().saveDocument();
      useRichTextStore.getState().clearDirty();
    });
    setStatus('saved');
    onSaveListeners.forEach((fn) => fn());
    setTimeout(() => {
      if (status === 'saved') setStatus('idle');
    }, 2000);
  } catch (err) {
    setStatus('error');
    const error = err instanceof Error ? err : new Error(String(err));
    onErrorListeners.forEach((fn) => fn(error));
  }
  pendingSave = false;
}

function scheduleDebouncedSave(): void {
  if (!usePersistenceStore.getState().autoSaveEnabled) return;
  if (timeoutId) clearTimeout(timeoutId);
  setStatus('pending');
  pendingSave = true;
  timeoutId = setTimeout(performSave, installedDebounceMs);
}

function flushNow(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  performSave();
}


/**
 * Install subscriptions and the unload-flush handler. Idempotent — safe
 * to call from every `useAutoSave()` site; only the first call actually
 * wires things up.
 */
function install(debounceMs: number): void {
  if (installed) return;
  installed = true;
  installedDebounceMs = debounceMs;

  registerAutoSaveFlush(() => {
    if (!pendingSave && !timeoutId) return;
    flushNow();
  });

  useDocumentStore.subscribe(() => {
    if (isAutoSaveSuppressed()) return;
    usePersistenceStore.getState().markDirty();
    scheduleDebouncedSave();
  });

  usePageStore.subscribe((state, prevState) => {
    if (isAutoSaveSuppressed()) return;
    if (state.pages !== prevState.pages || state.pageOrder !== prevState.pageOrder) {
      usePersistenceStore.getState().markDirty();
      scheduleDebouncedSave();
    }
  });

  useRichTextStore.subscribe((state, prevState) => {
    if (isAutoSaveSuppressed()) return;
    if (state.isDirty && !prevState.isDirty) {
      usePersistenceStore.getState().markDirty();
      scheduleDebouncedSave();
    }
  });

  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (pendingSave || usePersistenceStore.getState().isDirty) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        usePersistenceStore.getState().saveDocument();
      } catch (err) {
        console.error('Failed to save on unload:', err);
      }
    }
    if (usePersistenceStore.getState().isDirty) {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      return e.returnValue;
    }
    return undefined;
  });

  // `beforeunload` is unreliable on mobile / iOS PWAs (it often doesn't fire
  // when the app is backgrounded or swiped away). Flush on the events that
  // *do* fire there — `visibilitychange` → hidden and `pagehide` — so a
  // pending debounced edit isn't lost when a PWA goes to the background.
  const flushOnHide = (): void => {
    if (!pendingSave && !usePersistenceStore.getState().isDirty) return;
    try {
      flushNow();
    } catch (err) {
      console.error('Failed to flush autosave on hide:', err);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
  });
  window.addEventListener('pagehide', flushOnHide);
}

// ============ React hook ============

export function useAutoSave(options: UseAutoSaveOptions = {}): UseAutoSaveResult {
  const { enabled = true, debounceMs = AUTO_SAVE_DEBOUNCE, onSave, onError } = options;

  // Install on first mount (idempotent across all call sites).
  useEffect(() => {
    if (enabled) install(debounceMs);
  }, [enabled, debounceMs]);

  // Forward per-instance callbacks into the singleton's listener sets.
  useEffect(() => {
    if (!onSave) return undefined;
    onSaveListeners.add(onSave);
    return () => {
      onSaveListeners.delete(onSave);
    };
  }, [onSave]);

  useEffect(() => {
    if (!onError) return undefined;
    onErrorListeners.add(onError);
    return () => {
      onErrorListeners.delete(onError);
    };
  }, [onError]);

  // Force a re-render when status changes so consumers see it.
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }, []);

  const isDirty = usePersistenceStore((s) => s.isDirty);
  const lastSavedAt = usePersistenceStore((s) => s.lastSavedAt);

  const saveNow = useCallback(() => flushNow(), []);

  return { status, isDirty, lastSavedAt, saveNow };
}

/**
 * Format a timestamp for display.
 */
export function formatLastSaved(timestamp: number | null): string {
  if (!timestamp) return 'Never saved';
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 5000) return 'Just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString();
}
