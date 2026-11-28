/**
 * The diagram tabs (DSK-260): labels, a page's menu without a right-click,
 * Delete with Undo, F2 to rename, and one tab stop for the row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlinePageTabs } from './InlinePageTabs';
import { usePageStore } from '../store/pageStore';
import { useDocumentStore } from '../store/documentStore';
import { useNotificationStore } from '../store/notificationStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';

let first = '';
let second = '';

beforeEach(() => {
  useNotificationStore.getState().dismissAll();
  usePendingPageDeletes.setState({ pending: {} });
  usePageStore.getState().reset();
  useDocumentStore.getState().clear();
  first = usePageStore.getState().createPage(); // "Canvas", opens on creation
  second = usePageStore.getState().createPage('Flow');
});

afterEach(cleanup);

const tabs = () => screen.getAllByRole('tab');
const tabNamed = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
const openMenuOf = (label: string) => fireEvent.click(screen.getByLabelText(`${label}: page menu`));
const lastToast = () => {
  const { notifications } = useNotificationStore.getState();
  return notifications[notifications.length - 1]!;
};

describe('the diagram tabs', () => {
  it('call a default-named diagram "Diagram N" and keep a chosen name', () => {
    render(<InlinePageTabs />);
    expect(screen.getByRole('tablist', { name: 'Diagram pages' })).toBeTruthy();
    // A tab names itself. Chrome gave these tabs no name from their content,
    // though jsdom computes one, so the attribute is what's pinned here.
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['Diagram 1', 'Flow']);
    expect(tabs().map((t) => t.querySelector('.inline-tab-name')?.textContent)).toEqual(['Diagram 1', 'Flow']);
  });

  it("open a page's menu from the ⋯ on its tab, no right-click needed", () => {
    render(<InlinePageTabs />);
    openMenuOf('Flow');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Duplicate', 'Delete page']);
  });

  it('open the menu from the keyboard, under the tab, and come back to the tab on Escape', () => {
    render(<InlinePageTabs />);
    tabNamed('Flow').focus();
    fireEvent.keyDown(tabNamed('Flow'), { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: 'Delete page' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(tabNamed('Flow'));

    fireEvent.keyDown(tabNamed('Flow'), { key: 'ContextMenu' });
    expect(screen.getByRole('menuitem', { name: 'Delete page' })).toBeTruthy();
  });

  it('open the same menu from a right-click', () => {
    render(<InlinePageTabs />);
    fireEvent.contextMenu(tabNamed('Flow'), { clientX: 40, clientY: 20 });
    expect(screen.getByRole('menuitem', { name: 'Delete page' })).toBeTruthy();
  });

  it('delete with Undo: the tab goes at once, the page only when the Undo window ends', () => {
    render(<InlinePageTabs />);
    openMenuOf('Flow');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page' }));
    expect(screen.queryByRole('tab', { name: /Flow/ })).toBeNull();
    expect(usePageStore.getState().pages[second]).toBeDefined();
    expect(lastToast()).toMatchObject({ message: '“Flow” deleted', actionLabel: 'Undo' });

    act(() => lastToast().onAction!());
    expect(tabNamed('Flow')).toBeTruthy();
  });

  it("won't delete the last diagram", () => {
    usePageStore.getState().deletePage(second);
    render(<InlinePageTabs />);
    openMenuOf('Diagram 1');
    expect(screen.getByRole('menuitem', { name: 'Delete page' }).hasAttribute('disabled')).toBe(true);
  });

  it('rename with F2; unchanged text leaves the default name as it is', () => {
    render(<InlinePageTabs />);
    const tab = tabNamed('Diagram 1');
    fireEvent.keyDown(tab, { key: 'F2' });
    const input = screen.getByLabelText('Page name') as HTMLInputElement;
    expect(input.value).toBe('Diagram 1');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(usePageStore.getState().pages[first]?.name).toBe('Canvas');

    fireEvent.keyDown(tabNamed('Diagram 1'), { key: 'F2' });
    const again = screen.getByLabelText('Page name');
    fireEvent.change(again, { target: { value: 'Data model' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(usePageStore.getState().pages[first]?.name).toBe('Data model');
    // The keys carry on from the tab, not from the page body.
    expect(document.activeElement).toBe(tabNamed('Data model'));

    fireEvent.keyDown(tabNamed('Data model'), { key: 'F2' });
    const third = screen.getByLabelText('Page name');
    fireEvent.change(third, { target: { value: 'Discarded' } });
    fireEvent.keyDown(third, { key: 'Escape' });
    expect(usePageStore.getState().pages[first]?.name).toBe('Data model');
    expect(document.activeElement).toBe(tabNamed('Data model'));
  });

  it('duplicate opens the copy', () => {
    render(<InlinePageTabs />);
    openMenuOf('Flow');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(usePageStore.getState().pageOrder).toHaveLength(3);
    expect(tabNamed('Flow \\(Copy\\)').getAttribute('aria-selected')).toBe('true');
  });

  it('are one tab stop, the open page, and arrow keys move along them', () => {
    render(<InlinePageTabs />);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1]);
    tabs()[0]!.focus();
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs()[1]);
    fireEvent.keyDown(tabs()[1]!, { key: 'Enter' });
    expect(usePageStore.getState().activePageId).toBe(second);
  });

  it('say what the add button adds', () => {
    render(<InlinePageTabs />);
    expect(screen.getByRole('button', { name: 'Add a diagram page' }).textContent).toContain('Diagram');
  });
});
