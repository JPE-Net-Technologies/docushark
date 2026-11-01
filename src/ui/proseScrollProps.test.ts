/**
 * The editor keeps a touch selection's handles clear of the mobile bar
 * (DSK-197): Android draws them below the selected line, and with
 * ProseMirror's defaults a line selected at the bottom of the writing area put
 * them under the bar, whose buttons took the drag.
 */
import { describe, it, expect } from 'vitest';
import { proseScrollProps, sharedProseEditorProps } from './TiptapEditor';

describe('proseScrollProps (DSK-197)', () => {
  it('on touch, scrolls before the caret reaches the bottom and leaves room for the handles', () => {
    const props = proseScrollProps(true) as {
      scrollMargin: { bottom: number; top: number };
      scrollThreshold: { bottom: number };
    };
    // Selection handles are about 28px tall below the line.
    expect(props.scrollMargin.bottom).toBeGreaterThanOrEqual(40);
    expect(props.scrollThreshold.bottom).toBe(props.scrollMargin.bottom);
    expect(props.scrollMargin.top).toBeGreaterThan(0);
  });

  it('keeps ProseMirror’s defaults with a mouse', () => {
    expect(proseScrollProps(false)).toEqual({});
  });

  it('reaches both editors through the shared props (jsdom is not a touch screen)', () => {
    expect('scrollMargin' in sharedProseEditorProps).toBe(false);
  });
});
