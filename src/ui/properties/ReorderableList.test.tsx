import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReorderableList } from './ReorderableList';

function renderList(onReorder = vi.fn(), items = ['a', 'b', 'c']) {
  render(
    <ReorderableList
      items={items}
      onReorder={onReorder}
      rowClassName="test-row"
      renderItem={(item, _index, handleProps) => (
        <>
          <span {...handleProps}>handle</span>
          <span>{item}</span>
        </>
      )}
    />
  );
  return onReorder;
}

describe('ReorderableList', () => {
  it('renders every item', () => {
    renderList();
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
  });

  it('exposes an accessible drag handle per row', () => {
    renderList();
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    expect(handles).toHaveLength(3);
  });

  it('reorders down with ArrowDown', () => {
    const onReorder = renderList();
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it('reorders up with ArrowUp', () => {
    const onReorder = renderList();
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    fireEvent.keyDown(handles[2]!, { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(2, 1);
  });

  it('does not reorder past the top', () => {
    const onReorder = renderList();
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    fireEvent.keyDown(handles[0]!, { key: 'ArrowUp' });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('commits a pointer drag via onReorder', () => {
    // In jsdom every row rect is zero, so the drop target resolves to index 0;
    // dragging row 2 therefore commits a move from 2 → 0. This exercises the
    // full pointerdown → pointermove → pointerup path.
    const onReorder = renderList();
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    fireEvent.pointerDown(handles[2]!, { button: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientY: 0 });
    fireEvent.pointerUp(window, { clientY: 0 });
    expect(onReorder).toHaveBeenCalledWith(2, 0);
  });
});
