/**
 * The status line's prose readout and Document stats (DSK-211).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useProseStatsStore } from '../services/proseStats';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';
import { ProseReadout } from './DocumentStats';

const page = (id: string, name: string, content: string, order: number) => ({
  id, name, content, order, createdAt: 1, modifiedAt: 1,
});

beforeEach(() => {
  useProseStatsStore.setState({ stats: { words: 4, characters: 20, paragraphs: 1, selectionWords: 0 } });
  useRichTextPagesStore.setState({
    pages: {
      p1: page('p1', 'Intro', '<p>live page, counted by the editor</p>', 0),
      p2: page('p2', 'Method', '<p>three more words</p>', 1),
    },
    pageOrder: ['p1', 'p2'],
    activePageId: 'p1',
  });
});

afterEach(() => {
  cleanup();
  usePendingPageDeletes.setState({ pending: {} });
});

describe('ProseReadout (DSK-211)', () => {
  it("shows the page's words and its place among the pages", () => {
    render(<ProseReadout />);
    expect(screen.getByRole('button', { name: '4 words' })).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });

  it('opens Document stats: this page live, the others from their saved text, and the total', () => {
    render(<ProseReadout />);
    fireEvent.click(screen.getByRole('button', { name: '4 words' }));
    const dialog = screen.getByRole('dialog', { name: 'Document stats' });
    expect(dialog.textContent).toContain('Paragraphs');
    expect(dialog.textContent).toContain('Method3');
    expect(dialog.textContent).toContain('7 words');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open for a press inside it, and closes for a press elsewhere', () => {
    render(<ProseReadout />);
    fireEvent.click(screen.getByRole('button', { name: '4 words' }));
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Document stats' }));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names pages as their tabs do, and leaves out one waiting out its Undo (DSK-260)', () => {
    useRichTextPagesStore.setState((st) => ({
      pages: { ...st.pages, p3: page('p3', 'Prose p.3', '<h2>Results</h2><p>two words</p>', 2) },
      pageOrder: ['p1', 'p2', 'p3'],
    }));
    render(<ProseReadout />);
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '4 words' }));
    const dialog = () => screen.getByRole('dialog', { name: 'Document stats' }).textContent ?? '';
    expect(dialog()).toContain('Results3');
    expect(dialog()).not.toContain('Prose p.3');

    act(() => {
      usePendingPageDeletes.setState({ pending: { p2: { kind: 'prose', toastId: 't', wasActive: false } } });
    });
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(dialog()).not.toContain('Method');
  });

  it('shows no page position for a one-page document', () => {
    useRichTextPagesStore.setState({ pageOrder: ['p1'] });
    render(<ProseReadout />);
    expect(screen.queryByText(/^Page \d+ of \d+$/)).toBeNull();
  });

  it('says nothing while no prose editor is open', () => {
    useProseStatsStore.setState({ stats: null });
    const { container } = render(<ProseReadout />);
    expect(container.textContent).toBe('');
  });
});
