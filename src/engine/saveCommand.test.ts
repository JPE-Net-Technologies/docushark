/**
 * Save now, on Mod+S (DSK-203).
 *
 * Nothing bound Mod+S (only the long-dead FileMenu did), so in the PWA it
 * opened the browser's "Save page as" over the document. The command saves at
 * once through the autosave path, and claims the key even where there is
 * nothing to save, since a key the registry declines goes back to the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const save = vi.hoisted(() => vi.fn());
vi.mock('../store/autoSaveGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/autoSaveGuard')>()),
  requestSaveNow: save,
}));
const doc = vi.hoisted(() => ({ readOnly: false }));
vi.mock('../store/documentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/documentRegistry')>()),
  isActiveDocReadOnly: () => doc.readOnly,
}));

import { commandShortcut, dispatchKey } from './CommandRegistry';
import { useNotificationStore } from '../store/notificationStore';

function modS(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  doc.readOnly = false;
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Save now on Mod+S (DSK-203)', () => {
  it('saves at once and keeps the browser dialog closed', () => {
    const event = modS();
    expect(dispatchKey(event, 'global')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('works while typing in the document', () => {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    const event = modS();
    expect(dispatchKey(event, 'global')).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('on a view-only document, says so and still keeps the dialog closed', () => {
    doc.readOnly = true;
    const info = vi.spyOn(useNotificationStore.getState(), 'info');
    const event = modS();
    expect(dispatchKey(event, 'global')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('is labelled for the platform', () => {
    expect(commandShortcut('file.save')).toBe('Ctrl+S');
  });
});
