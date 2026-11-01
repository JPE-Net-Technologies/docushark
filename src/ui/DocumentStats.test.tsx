/**
 * The status line's prose readout and Document stats (DSK-211).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useProseStatsStore } from '../services/proseStats';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
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

afterEach(cleanup);

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
