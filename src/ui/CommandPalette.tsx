/**
 * Command palette — commands and documents, one list.
 *
 * ## Two sources, one keyboard model
 *
 * The palette used to search commands only, so "open that document I was in
 * yesterday" meant leaving the keyboard for the document browser. It now
 * searches documents too, and the two are merged into a single flat list that
 * arrow keys traverse continuously; the section headings are labels drawn
 * between runs, not stops. A reader holding Down should never have to notice
 * that a boundary exists.
 *
 * Sources are a small internal array rather than a registry. There are two of
 * them, and `registerCommandSource` already exists for contributing *commands*
 * — inventing a second seam for one more result type would be a registry built
 * for an audience of one. If a third type arrives (pages, shapes), promoting
 * this to a `registerResultSource` is mechanical.
 *
 * ## What an empty query shows
 *
 * Recent commands, exactly as before. Documents appear only once you type:
 * quick-open is something you go looking for, and putting documents in the
 * default view would push the recents people already rely on below the fold.
 *
 * ## Styling
 *
 * Rows borrow the tile system's anatomy — an icon chip, then the title, then a
 * trailing value — so the palette and the Tools grid read as one vocabulary.
 * They are NOT tiles: a palette is a keyboard-driven filtered list, and a 2D
 * grid would break up/down semantics and make scan-while-typing harder.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FileText, Cloud, HardDrive } from 'lucide-react';

import {
  getPaletteCommands,
  recordRecent,
  getRecentCommandIds,
  fuzzyMatch,
  type Command,
} from '../engine/CommandRegistry';
import { useDocumentRegistry } from '../store/documentRegistry';
import { openDocumentById } from '../services/openDocument';
import type { DocumentRecord } from '../types/DocumentRegistry';
import { Icon } from './icons';
import { device } from '../platform/device';
import './CommandPalette.css';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Most documents a query contributes, so commands are never pushed off-screen. */
const MAX_DOCUMENT_RESULTS = 6;

type PaletteResult =
  | { kind: 'command'; id: string; command: Command }
  | { kind: 'document'; id: string; record: DocumentRecord };

/** Section label a result belongs under. Runs are drawn in encounter order. */
function sectionOf(r: PaletteResult): string {
  return r.kind === 'command' ? 'Commands' : 'Documents';
}

/** A relay-backed document is worth distinguishing from a local one at a glance. */
function documentIcon(record: DocumentRecord) {
  if (record.type === 'remote' || record.type === 'cached') return Cloud;
  return record.type === 'local' ? HardDrive : FileText;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entries = useDocumentRegistry((s) => s.entries);
  const activeDocumentId = useDocumentRegistry((s) => s.activeDocumentId);

  const commands = useMemo(() => {
    const all = getPaletteCommands();
    return all.filter((c) => !c.canExecute || c.canExecute());
  }, [isOpen]); // re-evaluate when palette opens

  const results = useMemo((): PaletteResult[] => {
    const q = query.trim();

    if (q === '') {
      // Unchanged from before documents existed: recents first, then the rest.
      const recentIds = getRecentCommandIds();
      const recent: Command[] = [];
      const rest: Command[] = [];
      for (const cmd of commands) {
        if (recentIds.includes(cmd.id)) recent.push(cmd);
        else rest.push(cmd);
      }
      recent.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
      return [...recent, ...rest].map((command) => ({ kind: 'command', id: command.id, command }));
    }

    const scoredCommands: Array<{ result: PaletteResult; score: number }> = [];
    for (const command of commands) {
      const labelMatch = fuzzyMatch(q, command.label);
      const catMatch = fuzzyMatch(q, command.category);
      if (labelMatch.match || catMatch.match) {
        scoredCommands.push({
          result: { kind: 'command', id: command.id, command },
          score: Math.max(labelMatch.score, catMatch.score),
        });
      }
    }
    scoredCommands.sort((a, b) => b.score - a.score);

    const scoredDocs: Array<{ result: PaletteResult; score: number }> = [];
    for (const [id, entry] of Object.entries(entries)) {
      // The open document is not somewhere you can go.
      if (id === activeDocumentId) continue;
      const record = entry.record;
      const match = fuzzyMatch(q, record.name);
      if (match.match) {
        scoredDocs.push({ result: { kind: 'document', id, record }, score: match.score });
      }
    }
    scoredDocs.sort((a, b) => b.score - a.score);

    // Commands first: the palette's primary job is still running an action, and
    // a workspace with many similarly-named documents should not be able to
    // bury the command you typed three letters of.
    return [
      ...scoredCommands.map((s) => s.result),
      ...scoredDocs.slice(0, MAX_DOCUMENT_RESULTS).map((s) => s.result),
    ];
  }, [query, commands, entries, activeDocumentId]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus the search input after render — but NOT on touch, where it would
      // pop the on-screen keyboard and shove the layout up. On touch the palette
      // opens straight to the tappable command list (it doubles as the mobile
      // action menu); tapping the field still focuses it to type.
      if (!device.isTouch()) {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  // Query by index rather than `children[i]`: section headings are children too,
  // so positional lookup drifts from the selection as soon as a heading renders.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, results]);

  const run = useCallback(
    (result: PaletteResult) => {
      onClose();
      // Defer so the palette closes first — an action that opens a dialog would
      // otherwise render it behind the closing overlay.
      requestAnimationFrame(() => {
        if (result.kind === 'command') {
          recordRecent(result.command.id);
          result.command.execute();
        } else {
          void openDocumentById(result.id);
        }
      });
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter': {
          e.preventDefault();
          const result = results[selectedIndex];
          if (result) run(result);
          break;
        }
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, run, onClose],
  );

  if (!isOpen) return null;

  let lastSection: string | null = null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Search commands and documents…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />

        <div className="command-palette-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="command-palette-empty">No matching commands or documents</div>
          ) : (
            results.map((result, i) => {
              const section = sectionOf(result);
              const heading = section !== lastSection ? section : null;
              lastSection = section;
              return (
                <div key={`${result.kind}:${result.id}`} className="command-palette-run">
                  {heading && <div className="command-palette-section">{heading}</div>}
                  <button
                    data-result-index={i}
                    className={`command-palette-item ${i === selectedIndex ? 'selected' : ''}`}
                    onClick={() => run(result)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span className="command-palette-chip" aria-hidden="true">
                      {result.kind === 'command' ? (
                        result.command.iconNode ?? (
                          result.command.icon ? <Icon icon={result.command.icon} size={15} /> : null
                        )
                      ) : (
                        <Icon icon={documentIcon(result.record)} size={15} />
                      )}
                    </span>
                    <span className="command-palette-item-label">
                      {result.kind === 'command' ? result.command.label : result.record.name}
                    </span>
                    <span className="command-palette-item-meta">
                      {result.kind === 'command' ? (
                        <>
                          {result.command.shortcut && (
                            <kbd className="command-palette-shortcut">{result.command.shortcut}</kbd>
                          )}
                          <span className="command-palette-category">{result.command.category}</span>
                        </>
                      ) : (
                        <span className="command-palette-category">
                          {result.record.type === 'local' ? 'Local' : 'Cloud'}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
