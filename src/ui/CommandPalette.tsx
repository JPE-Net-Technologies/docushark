/**
 * Command Palette — Cmd/Ctrl+K opens a fuzzy-search overlay for all app actions.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  getPaletteCommands,
  fuzzyMatch,
  recordRecent,
  getRecentCommandIds,
  type Command,
} from '../engine/CommandRegistry';
import './CommandPalette.css';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Get all available commands
  const commands = useMemo(() => {
    const all = getPaletteCommands();
    return all.filter((c) => !c.canExecute || c.canExecute());
  }, [isOpen]); // re-evaluate when palette opens

  // Filter + sort by fuzzy match score & recency
  const filtered = useMemo(() => {
    if (query.trim() === '') {
      // Show recent commands first, then all
      const recentIds = getRecentCommandIds();
      const recent: Command[] = [];
      const rest: Command[] = [];
      for (const cmd of commands) {
        if (recentIds.includes(cmd.id)) {
          recent.push(cmd);
        } else {
          rest.push(cmd);
        }
      }
      // Sort recent by recency order
      recent.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
      return [...recent, ...rest];
    }

    const scored: Array<{ cmd: Command; score: number }> = [];
    for (const cmd of commands) {
      const labelMatch = fuzzyMatch(query, cmd.label);
      const catMatch = fuzzyMatch(query, cmd.category);
      const bestScore = Math.max(labelMatch.score, catMatch.score);
      if (labelMatch.match || catMatch.match) {
        scored.push({ cmd, score: bestScore });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [query, commands]);

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Clamp selected index when list changes
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const executeCommand = useCallback(
    (cmd: Command) => {
      recordRecent(cmd.id);
      onClose();
      // Defer execution so the palette closes first
      requestAnimationFrame(() => cmd.execute());
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter': {
          e.preventDefault();
          const cmd = filtered[selectedIndex];
          if (cmd) executeCommand(cmd);
          break;
        }
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, executeCommand, onClose]
  );

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />

        <div className="command-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No matching commands</div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                className={`command-palette-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="command-palette-item-label">{cmd.label}</span>
                <span className="command-palette-item-meta">
                  {cmd.shortcut && <kbd className="command-palette-shortcut">{cmd.shortcut}</kbd>}
                  <span className="command-palette-category">{cmd.category}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
