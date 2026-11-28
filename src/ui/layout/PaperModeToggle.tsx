/**
 * PaperModeToggle — turns Paper Mode on and off (DSK-48): the prose shown as
 * the PDF's pages. It sits beside Write · Split · Canvas and shows only where
 * Paper Mode can (`usePaperModeAvailable`).
 *
 * It's an on/off switch, not a fourth focus (DSK-257): a switch, not the
 * focus segments' fill, marks it on. While it's on, PDF beside it opens the
 * export, one click from the pages it shows.
 */

import { FileDown, FileText } from 'lucide-react';
import { Icon } from '../icons';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { usePaperModeAvailable } from '../../paper/usePaperMode';
import './RelaxedFocusControl.css';

export function PaperModeToggle() {
  const available = usePaperModeAvailable();
  const on = useUIPreferencesStore((s) => s.paperMode);
  const setPaperMode = useUIPreferencesStore((s) => s.setPaperMode);
  if (!available) return null;

  return (
    <div className="relaxed-focus-control paper-mode-control" role="group" aria-label="Page view">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`relaxed-focus-segment paper-mode-switch${on ? ' on' : ''}`}
        onClick={() => setPaperMode(!on)}
        title={on ? 'Paper Mode is on: the document as its PDF pages' : 'Paper Mode: see the document as its PDF pages'}
      >
        <Icon icon={FileText} size={14} />
        <span className="relaxed-focus-segment-label">Paper</span>
        <span className="paper-mode-switch-track" aria-hidden="true">
          <span className="paper-mode-switch-knob" />
        </span>
      </button>
      {on && (
        <button
          type="button"
          className="relaxed-focus-segment paper-mode-pdf"
          onClick={() => window.dispatchEvent(new CustomEvent('docushark:open-pdf-export'))}
          title="Export these pages to PDF"
        >
          <Icon icon={FileDown} size={14} />
          <span className="relaxed-focus-segment-label">PDF</span>
        </button>
      )}
    </div>
  );
}
