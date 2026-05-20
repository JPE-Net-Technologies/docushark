import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { Mark, MarkType } from '@tiptap/pm/model';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import './InsertLinkDialog.css';

/**
 * Walk left + right from the current cursor while the same link mark is present,
 * returning the full document range covered by that link mark (or null if the
 * cursor isn't currently inside one).
 */
function findLinkRange(editor: Editor): { from: number; to: number; mark: Mark } | null {
  const { state } = editor;
  const linkType = state.schema.marks['link'] as MarkType | undefined;
  if (!linkType) return null;
  const $pos = state.doc.resolve(state.selection.from);
  const linkMark = $pos.marks().find((m) => m.type === linkType);
  if (!linkMark) return null;

  const matches = (mark: Mark) => mark.type === linkType && mark.attrs['href'] === linkMark.attrs['href'];

  let from = state.selection.from;
  while (from > 0) {
    const probe = state.doc.resolve(from - 1);
    const node = probe.parent.maybeChild(probe.index());
    if (!node || !node.marks.some(matches)) break;
    from--;
  }
  let to = state.selection.to;
  while (to < state.doc.content.size) {
    const probe = state.doc.resolve(to);
    const node = probe.parent.maybeChild(probe.index());
    if (!node || !node.marks.some(matches)) break;
    to++;
  }
  return { from, to, mark: linkMark };
}

export interface InsertLinkDialogProps {
  editor: Editor;
  onClose: () => void;
}

type Mode = 'web' | 'internal';

interface HeadingEntry {
  pageId: string;
  pageName: string;
  index: number;
  level: number;
  text: string;
}

function parseHeadings(pageId: string, pageName: string, html: string): HeadingEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const els = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
  return Array.from(els).map((el, i) => ({
    pageId,
    pageName,
    index: i,
    level: parseInt(el.tagName.slice(1), 10),
    text: el.textContent?.trim() ?? '',
  }));
}

const HEADING_HREF_RE = /^docushark:\/\/heading\/([^/]+)\/(\d+)$/;

export function InsertLinkDialog({ editor, onClose }: InsertLinkDialogProps) {
  const { pages, pageOrder, activePageId } = useRichTextPagesStore();

  const initial = useMemo(() => {
    const { from, to, empty } = editor.state.selection;
    const linkRange = findLinkRange(editor);
    let selectedText = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
    let existingHref = '';
    if (linkRange) {
      selectedText = editor.state.doc.textBetween(linkRange.from, linkRange.to, ' ');
      existingHref = (linkRange.mark.attrs['href'] as string | undefined) ?? '';
    } else {
      const existing = editor.getAttributes('link') as { href?: string } | undefined;
      existingHref = existing?.href ?? '';
    }
    return { selectedText, existingHref, linkRange };
  }, [editor]);

  const headings = useMemo<HeadingEntry[]>(() => {
    const out: HeadingEntry[] = [];
    for (const id of pageOrder) {
      const page = pages[id];
      if (!page) continue;
      const html = id === activePageId ? editor.getHTML() : page.content;
      out.push(...parseHeadings(id, page.name, html));
    }
    return out;
  }, [pages, pageOrder, activePageId, editor]);

  const startMode: Mode = HEADING_HREF_RE.test(initial.existingHref) ? 'internal' : 'web';
  const [mode, setMode] = useState<Mode>(startMode);
  const [url, setUrl] = useState(startMode === 'web' ? initial.existingHref : '');
  const [text, setText] = useState(initial.selectedText);

  const [pickedKey, setPickedKey] = useState<string>(() => {
    const m = initial.existingHref.match(HEADING_HREF_RE);
    if (m) return `${m[1]}::${m[2]}`;
    const first = headings[0];
    return first ? `${first.pageId}::${first.index}` : '';
  });

  // Filter for the heading picker
  const [headingFilter, setHeadingFilter] = useState('');
  const filteredHeadings = useMemo(() => {
    const q = headingFilter.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter(
      (h) =>
        h.text.toLowerCase().includes(q) ||
        h.pageName.toLowerCase().includes(q),
    );
  }, [headings, headingFilter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = () => {
    let href = '';
    let displayText = text.trim();
    if (mode === 'web') {
      href = url.trim();
      if (!href) return;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        href = `https://${href}`;
      }
    } else {
      if (!pickedKey) return;
      const [pageId, indexStr] = pickedKey.split('::');
      const target = headings.find((h) => h.pageId === pageId && String(h.index) === indexStr);
      if (!target) return;
      href = `docushark://heading/${pageId}/${indexStr}`;
      if (!displayText) {
        displayText = target.text || target.pageName;
      }
    }

    const { from, to, empty } = editor.state.selection;
    const finalText = displayText || href;

    if (initial.linkRange) {
      editor
        .chain()
        .focus()
        .setTextSelection(initial.linkRange)
        .deleteSelection()
        .insertContent({
          type: 'text',
          text: finalText,
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
      onClose();
      return;
    }

    if (empty) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: finalText,
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    } else if (displayText && displayText !== initial.selectedText) {
      editor
        .chain()
        .focus()
        .deleteSelection()
        .insertContent({
          type: 'text',
          text: finalText,
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    } else {
      editor.chain().focus().setMark('link', { href }).setTextSelection({ from, to }).run();
    }
    onClose();
  };

  const remove = () => {
    if (initial.linkRange) {
      editor
        .chain()
        .focus()
        .setTextSelection(initial.linkRange)
        .unsetMark('link')
        .run();
    } else {
      editor.chain().focus().unsetMark('link').run();
    }
    onClose();
  };

  const isEditing = !!initial.existingHref;

  return createPortal(
    <div className="link-dialog-overlay" onMouseDown={onClose}>
      <div
        className="link-dialog"
        role="dialog"
        aria-label={isEditing ? 'Edit link' : 'Insert link'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="link-dialog-header">
          <h3>{isEditing ? 'Edit Link' : 'Insert Link'}</h3>
          <button className="link-dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="link-dialog-body">
          <div className="link-dialog-segment" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'web'}
              className={mode === 'web' ? 'active' : ''}
              onClick={() => setMode('web')}
            >
              <svg className="link-dialog-segment-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 010-3.5l2-2a2.5 2.5 0 013.5 3.5M11 5a2.5 2.5 0 010 3.5l-2 2a2.5 2.5 0 01-3.5-3.5" strokeLinecap="round" />
              </svg>
              Web URL
            </button>
            <button
              role="tab"
              aria-selected={mode === 'internal'}
              className={mode === 'internal' ? 'active' : ''}
              onClick={() => setMode('internal')}
            >
              <svg className="link-dialog-segment-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 4h10M3 8h7M3 12h10" strokeLinecap="round" />
              </svg>
              Heading
            </button>
          </div>

          {mode === 'web' ? (
            <div className="link-dialog-field">
              <label htmlFor="link-dialog-url">URL</label>
              <input
                id="link-dialog-url"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') apply();
                }}
              />
            </div>
          ) : (
            <div className="link-dialog-field">
              <label>Target heading</label>
              {headings.length === 0 ? (
                <div className="link-dialog-empty">
                  No headings exist in this document yet.
                  <br />
                  Add a heading first, then come back to link to it.
                </div>
              ) : (
                <>
                  <input
                    type="search"
                    className="link-dialog-search"
                    value={headingFilter}
                    onChange={(e) => setHeadingFilter(e.target.value)}
                    placeholder="Filter headings…"
                  />
                  <div className="link-dialog-heading-list" role="listbox">
                    {filteredHeadings.length === 0 ? (
                      <div className="link-dialog-empty">No matches</div>
                    ) : (
                      filteredHeadings.map((h) => {
                        const key = `${h.pageId}::${h.index}`;
                        const selected = key === pickedKey;
                        return (
                          <button
                            key={key}
                            role="option"
                            aria-selected={selected}
                            className={`link-dialog-heading-item ${selected ? 'selected' : ''}`}
                            onClick={() => setPickedKey(key)}
                            onDoubleClick={apply}
                          >
                            <span className={`link-dialog-heading-level lvl-${h.level}`}>
                              H{h.level}
                            </span>
                            <span className="link-dialog-heading-text">
                              {h.text || <em>(empty heading)</em>}
                            </span>
                            <span className="link-dialog-heading-page">{h.pageName}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="link-dialog-field">
            <label htmlFor="link-dialog-text">Display text</label>
            <input
              id="link-dialog-text"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode === 'internal' ? 'Defaults to the heading text' : 'Defaults to the URL'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply();
              }}
            />
          </div>
        </div>

        <footer className="link-dialog-footer">
          <div className="link-dialog-footer-hint">Enter to confirm · Esc to cancel</div>
          <div className="link-dialog-footer-actions">
            {isEditing && (
              <button className="link-dialog-btn link-dialog-btn-danger" onClick={remove}>
                Remove Link
              </button>
            )}
            <button className="link-dialog-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="link-dialog-btn link-dialog-btn-primary"
              onClick={apply}
              disabled={mode === 'internal' && headings.length === 0}
            >
              {isEditing ? 'Update' : 'Insert'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
