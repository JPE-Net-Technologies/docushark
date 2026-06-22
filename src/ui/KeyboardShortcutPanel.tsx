import { useState, useEffect, useCallback } from 'react';
import { getAllCommands } from '../engine/CommandRegistry';
import type { ShortcutCategory } from '../engine/KeyboardShortcuts';
import './KeyboardShortcutPanel.css';

/**
 * Shortcut rows grouped by category, derived from the central command registry
 * (the single source of truth — no separate hardcoded list to drift). Only
 * commands with a real binding (`shortcut`) are shown.
 */
function getShortcutsByCategory(): Map<ShortcutCategory, Array<{ keys: string; description: string }>> {
  const map = new Map<ShortcutCategory, Array<{ keys: string; description: string }>>();
  for (const cmd of getAllCommands()) {
    if (!cmd.shortcut) continue;
    const list = map.get(cmd.category) ?? [];
    list.push({ keys: cmd.shortcut, description: cmd.label });
    map.set(cmd.category, list);
  }
  return map;
}

interface KeyboardShortcutPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Keyboard shortcut reference panel.
 * Shows all available shortcuts grouped by category with search/filter.
 * Triggered by pressing `?`.
 */
export function KeyboardShortcutPanel({ isOpen, onClose }: KeyboardShortcutPanelProps) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (isOpen) setFilter('');
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  if (!isOpen) return null;

  const grouped = getShortcutsByCategory();
  const lowerFilter = filter.toLowerCase();

  const categories: ShortcutCategory[] = ['Tools', 'Navigation', 'Editing', 'File', 'View'];

  return (
    <div className="shortcut-panel__overlay" onClick={onClose}>
      <div
        className="shortcut-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="shortcut-panel__header">
          <h2 className="shortcut-panel__title">Keyboard Shortcuts</h2>
          <button className="shortcut-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          className="shortcut-panel__search"
          type="text"
          placeholder="Search shortcuts..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <div className="shortcut-panel__content">
          {categories.map((category) => {
            const shortcuts = grouped.get(category) ?? [];
            const filtered = lowerFilter
              ? shortcuts.filter(
                  (s) =>
                    s.description.toLowerCase().includes(lowerFilter) ||
                    s.keys.toLowerCase().includes(lowerFilter),
                )
              : shortcuts;

            if (filtered.length === 0) return null;

            return (
              <div key={category} className="shortcut-panel__category">
                <h3 className="shortcut-panel__category-title">{category}</h3>
                {filtered.map((shortcut) => (
                  <div key={shortcut.keys} className="shortcut-panel__row">
                    <span className="shortcut-panel__description">
                      {shortcut.description}
                    </span>
                    <kbd className="shortcut-panel__keys">{shortcut.keys}</kbd>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
