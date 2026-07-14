/**
 * Durable block ids (JP-432 Pillar C) — mint-sweep behavior.
 *
 * The invariants under test: ids mint ONLY on locally-authored edits (never on
 * construction, silent loads, remote collab transactions, or projection
 * write-backs — so viewing a doc can't dirty it), existing ids are preserved,
 * Enter-split yields a fresh id (`keepOnSplit: false`), and duplicate ids from
 * paste/copy are re-minted keeping the first occurrence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { ySyncPluginKey } from 'y-prosemirror';
import { extensions } from '../ui/TiptapEditor';
import { PROSE_PROJECTION_META } from './proseProjection';

const BLOCK_ID_RE = /id="blk-[A-Za-z0-9_-]{10}"/g;

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  return ed;
}

/** All block ids in document order. */
function idsIn(ed: Editor): string[] {
  const out: string[] = [];
  ed.state.doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string' && id.length > 0) out.push(id);
  });
  return out;
}

describe('BlockId schema declaration', () => {
  it('declares id (default null) on heading, paragraph and codeBlock only', () => {
    const ed = make('<p>x</p>');
    for (const name of ['heading', 'paragraph', 'codeBlock']) {
      const spec = ed.schema.nodes[name]!.spec.attrs;
      expect(spec, name).toHaveProperty('id');
      expect((spec as Record<string, { default: unknown }>)['id']!.default).toBeNull();
    }
    // Containers are addressed through their leaves — no id of their own.
    for (const name of ['blockquote', 'listItem', 'bulletList', 'table']) {
      expect(ed.schema.nodes[name]!.spec.attrs ?? {}, name).not.toHaveProperty('id');
    }
  });

  it('round-trips an explicit id and renders it into the DOM', () => {
    const ed = make('<h2 id="blk-fixedid001">T</h2>');
    expect(ed.getHTML()).toContain('id="blk-fixedid001"');
    expect(ed.view.dom.querySelector('h2#blk-fixedid001')).not.toBeNull();
  });
});

describe('mint sweep', () => {
  it('does not mint on construction or on a silent setContent (load path)', () => {
    const ed = make('<h2>T</h2><p>a</p>');
    expect(idsIn(ed)).toEqual([]);
    // The document-load path: setContent with emitUpdate defaulted false
    // (Tiptap tags the transaction `preventUpdate`).
    ed.commands.setContent('<p>loaded</p><p>again</p>');
    expect(idsIn(ed)).toEqual([]);
  });

  it('sweeps the whole doc on the first local edit', () => {
    const ed = make('<h2>T</h2><p>a</p><blockquote><p>q</p></blockquote>');
    ed.commands.insertContentAt(ed.state.doc.content.size, '<p>typed</p>');
    const ids = idsIn(ed);
    expect(ids).toHaveLength(4); // h2, p, quoted p, typed p
    expect(new Set(ids).size).toBe(4);
    expect(ed.getHTML().match(BLOCK_ID_RE)).toHaveLength(4);
  });

  it('preserves existing ids while filling gaps', () => {
    const ed = make('<h2 id="blk-keepme0001">T</h2><p>a</p>');
    ed.commands.insertContentAt(ed.state.doc.content.size, '<p>typed</p>');
    const ids = idsIn(ed);
    expect(ids[0]).toBe('blk-keepme0001');
    expect(ids).toHaveLength(3);
  });

  it('does not mint on remote collab or projection transactions', () => {
    const ed = make('<p>a</p>');
    ed.view.dispatch(ed.state.tr.insertText('remote', 1).setMeta(ySyncPluginKey, {}));
    expect(idsIn(ed)).toEqual([]);
    ed.view.dispatch(ed.state.tr.insertText('derived', 1).setMeta(PROSE_PROJECTION_META, true));
    expect(idsIn(ed)).toEqual([]);
    ed.view.dispatch(ed.state.tr.insertText('silent', 1).setMeta('addToHistory', false));
    expect(idsIn(ed)).toEqual([]);
  });

  it('Enter-split yields a fresh id on the new block (keepOnSplit: false)', () => {
    const ed = make('<p>split here</p>');
    ed.commands.insertContentAt(ed.state.doc.content.size, '<p>edit</p>'); // trigger sweep
    const before = idsIn(ed);
    ed.commands.setTextSelection(6); // inside "split here"
    ed.commands.splitBlock();
    const after = idsIn(ed);
    expect(after).toHaveLength(before.length + 1);
    expect(new Set(after).size).toBe(after.length); // no duplicate survived
    expect(after[0]).toBe(before[0]); // the original block keeps its id
  });

  it('re-mints the LATER duplicate on paste, keeping the first occurrence', () => {
    const ed = make('<p id="blk-original01">first</p>');
    ed.commands.insertContentAt(
      ed.state.doc.content.size,
      '<p id="blk-original01">pasted copy</p>',
    );
    const ids = idsIn(ed);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('blk-original01');
    expect(ids[1]).not.toBe('blk-original01');
  });
});
