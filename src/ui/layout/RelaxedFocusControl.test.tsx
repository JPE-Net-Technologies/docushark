/**
 * The canvas focus reads "Canvas" (DSK-234). The stored value stays `diagram`,
 * so saved layouts and anything else that holds it keep working.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RelaxedFocusControl } from './RelaxedFocusControl';
import { useSessionStore } from '../../store/sessionStore';
import { getAllCommands } from '../../engine/CommandRegistry';

afterEach(() => {
  cleanup();
  useSessionStore.setState({ relaxedFocus: 'write' });
});

describe('the focus control names the canvas focus Canvas (DSK-234)', () => {
  it('reads Write, Canvas, with no Diagram', () => {
    render(<RelaxedFocusControl />);
    const group = screen.getByRole('group', { name: 'Editor focus' });
    expect(group.textContent).toContain('Write');
    expect(group.textContent).toContain('Canvas');
    expect(group.textContent).not.toContain('Diagram');
  });

  it('choosing Canvas still stores the focus as diagram', () => {
    render(<RelaxedFocusControl />);
    fireEvent.click(screen.getByRole('button', { name: /^Canvas/ }));
    expect(useSessionStore.getState().relaxedFocus).toBe('diagram');
  });

  it('a focus already held as diagram shows Canvas as chosen', () => {
    useSessionStore.setState({ relaxedFocus: 'diagram' });
    render(<RelaxedFocusControl />);
    expect(screen.getByRole('button', { name: /^Canvas/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the cycle command names the focuses as the control does', () => {
    const cycle = getAllCommands().find((c) => c.id === 'view.cycleRelaxedFocus');
    expect(cycle?.label).toBe('Cycle write / split / canvas focus');
  });
});
