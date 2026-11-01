/**
 * The prose ribbon on a mirror page (DSK-193).
 *
 * Found in the 2026-10-20 integrations walkthrough: a mirrored Notion page was
 * read-only, but its ribbon stayed fully live (it even auto-switched to the
 * Table tab, offering insert-row and delete), typing did nothing without a
 * word, and the only cue that the page was a mirror was the provider mark on
 * its tab. The document-level read-only check (JP-462) never saw it, because
 * a mirror is read-only page by page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ readOnly: false, dom: null as HTMLElement | null }));

vi.mock('../store/documentRegistry', () => ({
  useActiveDocReadOnly: () => h.readOnly,
}));
vi.mock('./TiptapEditorContext', () => ({
  useTiptapEditor: () => ({
    isActive: () => false,
    on: vi.fn(),
    off: vi.fn(),
    can: () => ({ chain: () => ({ focus: () => ({ run: () => true }) }) }),
    getAttributes: () => ({}),
    state: { selection: {} },
    isDestroyed: false,
    view: { dom: h.dom },
  }),
}));
vi.mock('../tiptap/slashUi', () => ({ registerSlashUiHandler: () => () => {} }));

import { DocumentEditorToolbar } from './DocumentEditorToolbar';
import { syncedLabel } from './integrations/MirrorBanner';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import type { PageMirrorMeta } from '../types/PageMirror';

const MIRROR: PageMirrorMeta = {
  provider: 'notion',
  externalId: 'ext-1',
  url: 'https://www.notion.so/ext-1',
  syncedAt: Date.now() - 2 * 60 * 60 * 1000,
};

function openPage(mirror?: PageMirrorMeta) {
  const pageId = useRichTextPagesStore.getState().createPage('Docs-Dogfooding');
  if (mirror) useRichTextPagesStore.getState().setPageMirror(pageId, mirror);
  useRichTextPagesStore.getState().setActivePage(pageId);
}

beforeEach(() => {
  h.readOnly = false;
  h.dom = document.createElement('div');
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
});
afterEach(cleanup);

describe('DocumentEditorToolbar on a mirror page', () => {
  it('replaces the ribbon with the mirror banner', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);

    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert row above' })).toBeNull();
    expect(screen.getByText(/Mirrored from Notion · read-only · synced 2 h ago/)).toBeTruthy();
  });

  it('carries the mirror actions', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);

    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open in Notion/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Detach/ })).toBeTruthy();
  });

  it('omits Open when the source has no URL', () => {
    openPage({ provider: 'notion', externalId: 'ext-1', syncedAt: MIRROR.syncedAt });
    render(<DocumentEditorToolbar />);
    expect(screen.queryByRole('button', { name: /Open in/ })).toBeNull();
  });

  // The read-only view cannot take focus, so a real keystroke after clicking
  // into the page arrives on the document, not on the editor's DOM. These
  // tests reproduce that path: a press inside the page, then a key on <body>.
  it('says why once the reader clicks into the page and tries to type', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);
    document.body.appendChild(h.dom!);

    act(() => {
      fireEvent.pointerDown(h.dom!);
      fireEvent.keyDown(document.body, { key: 'a' });
    });

    expect(screen.getByText('This page mirrors Notion and is read-only. Detach it to edit.')).toBeTruthy();
    h.dom!.remove();
  });

  it('ignores shortcuts, which do not edit', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);
    document.body.appendChild(h.dom!);

    act(() => {
      fireEvent.pointerDown(h.dom!);
      fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true });
    });

    expect(screen.queryByText(/Detach it to edit/)).toBeNull();
    h.dom!.remove();
  });

  it('ignores typing after a click outside the page', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);
    document.body.appendChild(h.dom!);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);

    act(() => {
      fireEvent.pointerDown(elsewhere);
      fireEvent.keyDown(document.body, { key: 'a' });
    });

    expect(screen.queryByText(/Detach it to edit/)).toBeNull();
    elsewhere.remove();
    h.dom!.remove();
  });

  it('ignores typing in another field, even after clicking into the page', () => {
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);
    document.body.appendChild(h.dom!);
    const search = document.createElement('input');
    document.body.appendChild(search);

    act(() => {
      fireEvent.pointerDown(h.dom!);
      fireEvent.keyDown(search, { key: 'a' });
    });

    expect(screen.queryByText(/Detach it to edit/)).toBeNull();
    search.remove();
    h.dom!.remove();
  });

  it('keeps the document-level View only strip when the whole document is read-only', () => {
    h.readOnly = true;
    openPage(MIRROR);
    render(<DocumentEditorToolbar />);

    expect(screen.getByText(/View only/)).toBeTruthy();
    expect(screen.queryByText(/Mirrored from/)).toBeNull();
  });

  it('offers the full ribbon on a normal page', () => {
    openPage();
    render(<DocumentEditorToolbar />);

    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
    expect(screen.queryByText(/Mirrored from/)).toBeNull();
  });
});

describe('syncedLabel', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);

  it('reads naturally across ranges', () => {
    expect(syncedLabel(now - 20_000, now)).toBe('just now');
    expect(syncedLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(syncedLabel(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(syncedLabel(now - 86_400_000, now)).toBe('1 day ago');
    expect(syncedLabel(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(syncedLabel(now - 45 * 86_400_000, now)).toMatch(/^on /);
  });

  it('never goes negative for a clock that runs ahead', () => {
    expect(syncedLabel(now + 60_000, now)).toBe('just now');
  });
});
