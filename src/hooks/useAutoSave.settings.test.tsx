/**
 * A document setting is part of the document (DSK-246): changing one, such as
 * the font, saves the document like any other edit.
 */
import { it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useAutoSave } from './useAutoSave';
import { usePersistenceStore } from '../store/persistenceStore';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import { withAutoSaveSuppressed } from '../store/autoSaveGuard';

function Harness() {
  useAutoSave();
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('marks the document unsaved when a setting changes, but not when one loads', () => {
  const markDirty = vi.spyOn(usePersistenceStore.getState(), 'markDirty');
  render(<Harness />);

  withAutoSaveSuppressed(() => useDocumentSettingsStore.getState().load({ font: 'Inter, sans-serif' }, 'doc'));
  expect(markDirty).not.toHaveBeenCalled();

  useDocumentSettingsStore.getState().set('font', "'Source Serif 4', serif");
  expect(markDirty).toHaveBeenCalledTimes(1);
});
