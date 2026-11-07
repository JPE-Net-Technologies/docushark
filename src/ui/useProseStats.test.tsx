/**
 * Publishing live counts for the open prose page (DSK-211), through a real editor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { useProseStatsStore } from '../services/proseStats';
import { useProseStats, RECOUNT_AFTER_MS } from './useProseStats';

let editor: Editor;
const stats = () => useProseStatsStore.getState().stats!;

beforeEach(() => {
  useProseStatsStore.setState({ stats: null });
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: [StarterKit], content: '<p>one two three</p>' });
});

afterEach(() => {
  cleanup();
  editor.destroy();
  vi.useRealTimers();
});

describe('useProseStats (DSK-211)', () => {
  it('publishes the page at once, and the selection as it changes', () => {
    renderHook(() => useProseStats(editor));
    expect(stats()).toMatchObject({ words: 3, selectionWords: 0 });

    editor.commands.setTextSelection({ from: 1, to: 8 });
    expect(stats().selectionWords).toBe(2);
  });

  it('recounts the page after a pause in typing', () => {
    vi.useFakeTimers();
    renderHook(() => useProseStats(editor));
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' four');
    expect(stats().words).toBe(3);

    vi.advanceTimersByTime(RECOUNT_AFTER_MS);
    expect(stats().words).toBe(4);
  });

  it('counts a page loaded without an update event', () => {
    vi.useFakeTimers();
    renderHook(() => useProseStats(editor));
    editor.commands.setContent('<p>a b c d e</p>', false);

    vi.advanceTimersByTime(RECOUNT_AFTER_MS);
    expect(stats().words).toBe(5);
  });

  it('clears the counts when the editor goes', () => {
    const { unmount } = renderHook(() => useProseStats(editor));
    unmount();
    expect(useProseStatsStore.getState().stats).toBeNull();
  });
});
