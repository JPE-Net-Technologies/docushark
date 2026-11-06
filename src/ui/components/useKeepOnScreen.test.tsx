/**
 * A picker that hangs from a trigger near the bottom of the screen slides up until
 * it fits (DSK-223), which a short phone sheet made hard to miss.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { useKeepOnScreen } from './useKeepOnScreen';
import { BorderStylePicker } from '../BorderStylePicker';
import { CompactColorInput } from '../CompactColorInput';
import { IconPicker } from '../IconPicker';
import { PatternPicker } from '../PatternPicker';

const SCREEN = 800;

function Picker({ top, height, children }: { top: number; height: number; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useKeepOnScreen(ref);
  return (
    <div
      data-testid="picker"
      style={{ top }}
      ref={(element) => {
        ref.current = element;
        if (element) element.getBoundingClientRect = () => ({ top, height }) as DOMRect;
      }}
    >
      {children}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubScreen() {
  vi.stubGlobal('innerHeight', SCREEN);
  vi.stubGlobal('visualViewport', undefined);
}

describe('useKeepOnScreen', () => {
  it('leaves a picker that fits where it hangs', () => {
    stubScreen();
    render(<Picker top={100} height={300} />);
    expect(screen.getByTestId('picker').style.top).toBe('100px');
  });

  it('slides up one that would run off the bottom', () => {
    stubScreen();
    render(<Picker top={600} height={400} />);
    expect(screen.getByTestId('picker').style.top).toBe(`${SCREEN - 400 - 8}px`);
  });

  it('keeps one taller than the screen at the top, scrolling', () => {
    stubScreen();
    render(<Picker top={600} height={1200} />);
    const picker = screen.getByTestId('picker');
    expect(picker.style.top).toBe('8px');
    expect(picker.style.maxHeight).toBe(`${SCREEN - 16}px`);
    expect(picker.style.overflowY).toBe('auto');
  });

  it('counts only the screen an on-screen keyboard leaves', () => {
    vi.stubGlobal('innerHeight', SCREEN);
    vi.stubGlobal('visualViewport', { height: 500 });
    render(<Picker top={300} height={400} />);
    expect(screen.getByTestId('picker').style.top).toBe('92px');
  });

  it('does nothing with no picker open', () => {
    function Closed() {
      useKeepOnScreen(useRef<HTMLDivElement>(null));
      return null;
    }
    expect(() => render(<Closed />)).not.toThrow();
  });
});

describe('the pickers', () => {
  // Everything measures low on the screen: the trigger, and the picker 300 tall.
  const stubLowOnScreen = () => {
    stubScreen();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 740,
      left: 10,
      right: 110,
      width: 100,
      height: 300,
    } as DOMRect);
  };

  it.each([
    [
      'colour',
      <CompactColorInput key="c" label="Fill" value="#123456" onChange={() => {}} />,
      () => screen.getByRole('button', { name: /fill picker/i }),
      '.compact-color-palette-portal',
    ],
    [
      'icon',
      <IconPicker key="i" value={undefined} onChange={() => {}} />,
      () => document.querySelector<HTMLElement>('.icon-picker-trigger') ?? screen.getAllByRole('button')[0]!,
      '.icon-picker-dropdown-portal',
    ],
    [
      'pattern',
      <PatternPicker key="p" value={undefined} onChange={() => {}} />,
      () => screen.getAllByRole('button')[0]!,
      '.pattern-picker-dropdown',
    ],
    [
      'border style',
      <BorderStylePicker key="b" value={undefined} onChange={() => {}} />,
      () => screen.getAllByRole('button')[0]!,
      '.border-style-dropdown',
    ],
  ])('keeps the %s picker on screen', (_name, element, trigger, selector) => {
    stubLowOnScreen();
    render(element);
    fireEvent.click(trigger());
    const picker = document.querySelector<HTMLElement>(selector);
    expect(picker).not.toBeNull();
    expect(picker!.style.top).toBe(`${SCREEN - 300 - 8}px`);
  });
});
