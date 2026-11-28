/**
 * PaperModeToggle — turns Paper Mode on and off (DSK-48): the prose shown as
 * the PDF's pages. It sits beside Write · Split · Canvas, styled like them,
 * and shows only where Paper Mode can (`usePaperModeAvailable`).
 */

import { FileText } from 'lucide-react';
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
    <div className="relaxed-focus-control" role="group" aria-label="Page view">
      <button
        type="button"
        className={`relaxed-focus-segment ${on ? 'active' : ''}`}
        onClick={() => setPaperMode(!on)}
        aria-pressed={on}
        title={on ? 'Paper Mode is on: the document as its PDF pages' : 'Paper Mode: see the document as its PDF pages'}
      >
        <Icon icon={FileText} size={14} />
        <span className="relaxed-focus-segment-label">Paper</span>
      </button>
    </div>
  );
}
