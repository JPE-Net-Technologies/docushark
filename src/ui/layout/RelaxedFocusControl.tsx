/**
 * RelaxedFocusControl — the writing-first focus switch.
 *
 * A segmented Write / Split / Diagram control shown in the toolbar only while
 * the Relaxed layout is active. It's the convenient, all-skill-levels way to
 * move between the expanded prose editor and the canvas (the design driver for
 * the prose-first rework), and the seed of the single-pane switcher a future
 * mobile (PWA) layout will reuse.
 *
 * On a narrow viewport the `Split` segment is dropped (no room for side-by-side)
 * — matching `resolveRegions`, which collapses split to single-pane prose there.
 */

import type { ReactNode } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useBreakpoint } from './useBreakpoint';
import type { RelaxedFocus } from './types';
import './RelaxedFocusControl.css';

interface Segment {
  id: RelaxedFocus;
  label: string;
  icon: ReactNode;
}

export function RelaxedFocusControl() {
  const focus = useSessionStore((s) => s.relaxedFocus);
  const setRelaxedFocus = useSessionStore((s) => s.setRelaxedFocus);
  const { band } = useBreakpoint();
  const allowSplit = band !== 'narrow';

  const segments: Segment[] = [
    { id: 'write', label: 'Write', icon: <WriteIcon /> },
    ...(allowSplit ? [{ id: 'split' as const, label: 'Split', icon: <SplitIcon /> }] : []),
    { id: 'diagram', label: 'Diagram', icon: <DiagramIcon /> },
  ];

  // When Split is unavailable, a lingering 'split' focus reads as document-primary
  // (write) per resolveRegions — reflect that in the active highlight.
  const active: RelaxedFocus = !allowSplit && focus === 'split' ? 'write' : focus;

  return (
    <div className="relaxed-focus-control" role="group" aria-label="Editor focus">
      {segments.map((seg) => (
        <button
          key={seg.id}
          type="button"
          className={`relaxed-focus-segment ${active === seg.id ? 'active' : ''}`}
          onClick={() => setRelaxedFocus(seg.id)}
          aria-pressed={active === seg.id}
          title={`${seg.label} (Ctrl+Shift+\\ to cycle)`}
        >
          {seg.icon}
          <span className="relaxed-focus-segment-label">{seg.label}</span>
        </button>
      ))}
    </div>
  );
}

function WriteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M3 4h10M3 7h10M3 10h7M3 13h5" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M9 3v10" />
    </svg>
  );
}

function DiagramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="2.5" width="5" height="4" rx="0.5" />
      <rect x="9" y="9.5" width="5" height="4" rx="0.5" />
      <path d="M7 4.5h3.5v5" />
    </svg>
  );
}
