/**
 * ConnectorStyleMenu — the small sidecar caret + dropdown that sits next to the
 * Connector tool in the canvas toolbar. It picks the style the connector tool
 * draws with: routing (straight / orthogonal), semantic type (arrows / UML),
 * and ERD relationship presets (which set start/end cardinality).
 *
 * There is no persisted "default" setting — the choice is remembered as
 * last-used (`settingsStore.lastConnector`) and applied to new connectors.
 * Picking an entry also activates the connector tool so it's draw-ready.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ArrowRight,
  Square,
  Minus,
  CornerDownRight,
  GitFork,
  Check,
} from 'lucide-react';
import {
  useSettingsStore,
  type ConnectorRoutingMode,
  type ConnectorDrawStyle,
} from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import './ConnectorStyleMenu.css';

const ICON_SIZE = 15;

interface RoutingDef {
  mode: ConnectorRoutingMode;
  label: string;
  icon: ReactNode;
}

const ROUTINGS: RoutingDef[] = [
  { mode: 'straight', label: 'Straight', icon: <Minus size={ICON_SIZE} /> },
  { mode: 'orthogonal', label: 'Orthogonal', icon: <CornerDownRight size={ICON_SIZE} /> },
];

/** A pickable connector type / ERD preset (the cardinality-bearing part). */
interface TypePreset {
  key: string;
  label: string;
  icon: ReactNode;
  style: Pick<ConnectorDrawStyle, 'connectorType' | 'startCardinality' | 'endCardinality'>;
}

const TYPE_PRESETS: TypePreset[] = [
  {
    key: 'arrows',
    label: 'Arrows',
    icon: <ArrowRight size={ICON_SIZE} />,
    style: { connectorType: 'default', startCardinality: 'none', endCardinality: 'none' },
  },
  {
    key: 'uml',
    label: 'UML',
    icon: <Square size={ICON_SIZE} />,
    style: { connectorType: 'uml-class', startCardinality: 'none', endCardinality: 'none' },
  },
];

const ERD_PRESETS: TypePreset[] = [
  {
    key: 'one-one',
    label: 'One-to-One',
    icon: <GitFork size={ICON_SIZE} />,
    style: { connectorType: 'erd', startCardinality: 'one', endCardinality: 'one' },
  },
  {
    key: 'one-many',
    label: 'One-to-Many',
    icon: <GitFork size={ICON_SIZE} />,
    style: { connectorType: 'erd', startCardinality: 'one', endCardinality: 'many' },
  },
  {
    key: 'many-many',
    label: 'Many-to-Many',
    icon: <GitFork size={ICON_SIZE} />,
    style: { connectorType: 'erd', startCardinality: 'many', endCardinality: 'many' },
  },
  {
    key: 'zero-many',
    label: 'Zero-or-Many',
    icon: <GitFork size={ICON_SIZE} />,
    style: { connectorType: 'erd', startCardinality: 'one', endCardinality: 'zero-many' },
  },
];

function styleMatches(last: ConnectorDrawStyle, p: TypePreset): boolean {
  return (
    last.connectorType === p.style.connectorType &&
    last.startCardinality === p.style.startCardinality &&
    last.endCardinality === p.style.endCardinality
  );
}

export function ConnectorStyleMenu() {
  const lastConnector = useSettingsStore((s) => s.lastConnector);
  const setLastConnector = useSettingsStore((s) => s.setLastConnector);
  const setActiveTool = useSessionStore((s) => s.setActiveTool);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickRouting = (mode: ConnectorRoutingMode) => {
    setLastConnector({ routingMode: mode });
    setActiveTool('connector');
  };

  const pickType = (p: TypePreset) => {
    setLastConnector(p.style);
    setActiveTool('connector');
    setOpen(false);
  };

  return (
    <div className="connector-style-menu" ref={rootRef}>
      <button
        type="button"
        className={`connector-style-caret ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Connector style"
        title="Connector style"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} strokeWidth={2.5} />
      </button>

      {open && (
        <div className="connector-style-popover" role="menu">
          <div className="connector-style-section-label">Routing</div>
          <div className="connector-style-routing">
            {ROUTINGS.map((r) => (
              <button
                key={r.mode}
                type="button"
                role="menuitemradio"
                aria-checked={lastConnector.routingMode === r.mode}
                className={`connector-style-pill ${lastConnector.routingMode === r.mode ? 'active' : ''}`}
                onClick={() => pickRouting(r.mode)}
              >
                {r.icon}
                <span>{r.label}</span>
              </button>
            ))}
          </div>

          <div className="connector-style-section-label">Type</div>
          {TYPE_PRESETS.map((p) => {
            const active = styleMatches(lastConnector, p);
            return (
              <button
                key={p.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`connector-style-item ${active ? 'active' : ''}`}
                onClick={() => pickType(p)}
              >
                <span className="connector-style-item-icon">{p.icon}</span>
                <span className="connector-style-item-label">{p.label}</span>
                {active && <Check size={14} className="connector-style-item-check" />}
              </button>
            );
          })}

          <div className="connector-style-section-label">ERD</div>
          {ERD_PRESETS.map((p) => {
            const active = styleMatches(lastConnector, p);
            return (
              <button
                key={p.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`connector-style-item ${active ? 'active' : ''}`}
                onClick={() => pickType(p)}
              >
                <span className="connector-style-item-icon">{p.icon}</span>
                <span className="connector-style-item-label">{p.label}</span>
                {active && <Check size={14} className="connector-style-item-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
