/**
 * The link dialog's heading list names each page as its tab does, and offers
 * nothing on a page waiting out its Undo (DSK-260).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { extensions } from './TiptapEditor';
import { InsertLinkDialog } from './InsertLinkDialog';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';

let editor: Editor | null = null;

const page = (id: string, name: string, content: string, order: number) => ({
  id, name, content, order, createdAt: 1, modifiedAt: 1,
});

beforeEach(() => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions, content: '<h1>Overview</h1><p>open page</p>' });
  useRichTextPagesStore.setState({
    pages: {
      p1: page('p1', 'Prose', '<h1>Overview</h1><p>open page</p>', 0),
      p2: page('p2', 'Prose p.2', '<h2>Data model</h2><h3>Keys</h3>', 1),
      p3: page('p3', 'Appendix', '<h2>Glossary</h2>', 2),
    },
    pageOrder: ['p1', 'p2', 'p3'],
    activePageId: 'p1',
  });
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  usePendingPageDeletes.setState({ pending: {} });
});

const rows = () =>
  screen.getAllByRole('option').map((o) => [
    o.querySelector('.link-dialog-heading-text')?.textContent,
    o.querySelector('.link-dialog-heading-page')?.textContent,
  ]);

describe('the link dialog’s headings', () => {
  it('name each page as its tab does', () => {
    render(<InsertLinkDialog editor={editor!} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Heading' }));
    expect(rows()).toEqual([
      ['Overview', 'Overview'],
      ['Data model', 'Data model'],
      ['Keys', 'Data model'],
      ['Glossary', 'Appendix'],
    ]);
  });

  it('leave out a page waiting out its Undo', () => {
    usePendingPageDeletes.setState({ pending: { p2: { kind: 'prose', toastId: 't', wasActive: false } } });
    render(<InsertLinkDialog editor={editor!} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Heading' }));
    expect(rows().map(([text]) => text)).toEqual(['Overview', 'Glossary']);
  });
});
