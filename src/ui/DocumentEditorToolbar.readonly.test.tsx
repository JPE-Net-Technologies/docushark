/**
 * The prose ribbon on a read-only document (JP-462).
 *
 * Found live: a document shared view-only opened correctly read-only, and then
 * rendered the full formatting ribbon anyway — sixty-odd controls driving an
 * editor that is already `editable: false`. Nothing was corrupted, and the
 * relay drops a viewer's writes regardless (JP-457), so this was never a
 * data-integrity bug. It is a truthfulness bug: the surface answered "here is
 * everything you can do" when the answer was "nothing".
 *
 * This matters more now than when it was filed. Every visitor arriving on a
 * share link is a read-only viewer, so this ribbon is the first thing a reader
 * sees — it has to say what it means.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ readOnly: false }));

vi.mock('../store/documentRegistry', () => ({
  useActiveDocReadOnly: () => h.readOnly,
}));
vi.mock('./TiptapEditorContext', () => ({
  useTiptapEditor: () => ({
    isActive: () => false,
    on: vi.fn(),
    off: vi.fn(),
    can: () => ({ chain: () => ({ focus: () => ({ run: () => true }) }) }),
    // The colour pickers read the selection's current colour so each opens
    // showing the colour in effect (JP-485).
    getAttributes: () => ({}),
    state: { selection: {} },
  }),
}));
vi.mock('../tiptap/slashUi', () => ({ registerSlashUiHandler: () => () => {} }));

import { DocumentEditorToolbar } from './DocumentEditorToolbar';

beforeEach(() => {
  h.readOnly = false;
});
afterEach(cleanup);

describe('DocumentEditorToolbar', () => {
  it('offers the full ribbon on an editable document', () => {
    render(<DocumentEditorToolbar />);
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
    expect(screen.queryByText(/View only/)).toBeNull();
  });

  it('replaces the ribbon with a View only strip when the document is read-only', () => {
    h.readOnly = true;
    render(<DocumentEditorToolbar />);

    // The load-bearing assertion: no formatting control is offered at all.
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Italic' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert or edit link' })).toBeNull();

    // And the reason is on screen, rather than left to be discovered by clicking.
    expect(screen.getByText(/View only/)).toBeTruthy();
  });

  it('says why, not just that', () => {
    h.readOnly = true;
    render(<DocumentEditorToolbar />);
    expect(screen.getByText(/permission to edit/)).toBeTruthy();
  });
});
