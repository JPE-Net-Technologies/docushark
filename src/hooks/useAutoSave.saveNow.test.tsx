/**
 * Save now reaches the real save (DSK-203).
 *
 * The command registry saves through `requestSaveNow` in the autoSaveGuard
 * leaf, so the engine never imports this hook. That only works if the hook
 * registers its save when it installs, which this pins.
 */
import { it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useAutoSave } from './useAutoSave';
import { requestSaveNow } from '../store/autoSaveGuard';
import { usePersistenceStore } from '../store/persistenceStore';

function Harness() {
  useAutoSave();
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('saves the open document when Save now is requested', () => {
  const saveDocument = vi.spyOn(usePersistenceStore.getState(), 'saveDocument').mockImplementation(() => {});
  usePersistenceStore.setState({ autoSaveEnabled: true });
  render(<Harness />);

  requestSaveNow();

  expect(saveDocument).toHaveBeenCalledTimes(1);
});
