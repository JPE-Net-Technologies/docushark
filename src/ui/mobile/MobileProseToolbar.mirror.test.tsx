/**
 * The phone's prose bar on a mirror page (DSK-197).
 *
 * DSK-193 gave the desktop ribbon a mirror banner, but the phone's bottom bar
 * only checked the document-level read-only flag, so on a mirrored Notion page
 * its Bold, Italic, Underline, Heading and list buttons stayed live, doing
 * nothing, with no word that the page was a mirror.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ readOnly: false }));

vi.mock('../../store/documentRegistry', () => ({
  useActiveDocReadOnly: () => h.readOnly,
}));
vi.mock('../TiptapEditorContext', () => ({
  useTiptapEditor: () => ({
    isActive: () => false,
    can: () => ({ undo: () => false, redo: () => false, sinkListItem: () => false, liftListItem: () => false }),
    on: vi.fn(),
    off: vi.fn(),
    isDestroyed: false,
    view: { dom: document.createElement('div') },
  }),
}));

import { MobileProseToolbar } from './MobileProseToolbar';
import { useRichTextPagesStore } from '../../store/richTextPagesStore';
import type { PageMirrorMeta } from '../../types/PageMirror';

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
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
});
afterEach(cleanup);

describe('MobileProseToolbar on a mirror page (DSK-197)', () => {
  it('shows the compact mirror banner instead of live marks', () => {
    openPage(MIRROR);
    render(<MobileProseToolbar />);

    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More formatting' })).toBeNull();
    expect(screen.getByText('Notion mirror · read-only')).toBeTruthy();
    expect(screen.getByText('Synced 2 h ago')).toBeTruthy();
  });

  it('carries the mirror actions as labelled icon buttons', () => {
    openPage(MIRROR);
    render(<MobileProseToolbar />);

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in Notion' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Detach' })).toBeTruthy();
  });

  it('keeps the formatting bar on an ordinary page', () => {
    openPage();
    render(<MobileProseToolbar />);

    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
    expect(screen.queryByText(/mirror · read-only/)).toBeNull();
  });

  it('says View only, not mirror, when the whole document is read-only', () => {
    h.readOnly = true;
    openPage(MIRROR);
    render(<MobileProseToolbar />);

    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByText(/mirror · read-only/)).toBeNull();
  });
});
