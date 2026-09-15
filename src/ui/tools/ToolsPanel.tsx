/**
 * The Tools surface, as tiles (JP-506 slice 1 + 2).
 *
 * ## It renders the registry, it does not describe the app
 *
 * The Tools menu used to build its own list of what the app can do, inline in
 * `UnifiedToolbar`. The command palette built a second list, in
 * `CommandRegistry`. They described the same four actions and had already
 * drifted: import carried two different labels, the PDF dialog had two paths
 * into it (the toolbar set local state, the palette dispatched an event), and
 * version history existed only on the toolbar, so the palette could not reach
 * it at all.
 *
 * So this panel holds no catalogue. It renders `getToolsActions()` — commands
 * that opted into the `tools` surface, are currently available, and carry an
 * icon. Adding a tool is adding a command; there is no second place to update,
 * which is the property the integration action catalogue (slice 3) needs before
 * it can contribute anything worth contributing.
 *
 * ## Grouping
 *
 * Tiles are grouped by the command's existing `category`, in a fixed order, so
 * the grid does not reshuffle as availability changes — a control that moves
 * when you are reaching for it is worse than one in an odd place.
 */

import { useMemo } from 'react';
import { Command as CommandIcon } from 'lucide-react';

import { getToolsActions, recordRecent, type Command } from '../../engine/CommandRegistry';
import type { ShortcutCategory } from '../../engine/KeyboardShortcuts';
import { ActionTile, TileGrid } from '../tiles/Tile';
import './ToolsPanel.css';

/**
 * Category order for the grid. Categories not listed fall to the end in
 * registry order, so a new category shows up rather than vanishing.
 */
const GROUP_ORDER: readonly ShortcutCategory[] = ['File', 'View', 'Editing', 'Tools', 'Navigation'];

export interface ToolsPanelProps {
  /** Run after a tile is activated — the toolbar uses it to close the popover. */
  onAction?: () => void;
  /** Open the command palette. Rendered as its own tile, always last. */
  onOpenPalette?: () => void;
}

function groupOf(c: Command): ShortcutCategory {
  return c.category;
}

export function ToolsPanel({ onAction, onOpenPalette }: ToolsPanelProps) {
  // Deliberately not memoized on the actions themselves: `canExecute` is read at
  // render time, and the toolbar re-renders when the stores behind those guards
  // change. Caching here would show a stale availability set.
  const actions = getToolsActions();

  const groups = useMemo(() => {
    const byGroup = new Map<ShortcutCategory, Command[]>();
    for (const a of actions) {
      const g = groupOf(a);
      const list = byGroup.get(g);
      if (list) list.push(a);
      else byGroup.set(g, [a]);
    }
    const ordered: Array<[ShortcutCategory, Command[]]> = [];
    for (const g of GROUP_ORDER) {
      const list = byGroup.get(g);
      if (list) {
        ordered.push([g, list]);
        byGroup.delete(g);
      }
    }
    // Anything with a category not in GROUP_ORDER still gets shown.
    for (const [g, list] of byGroup) ordered.push([g, list]);
    return ordered;
  }, [actions]);

  return (
    <div className="tools-panel">
      {groups.map(([group, list]) => (
        <section key={group} className="tools-panel__group">
          <h3 className="tools-panel__group-title">{group}</h3>
          <TileGrid min={150} row={78}>
            {list.map((action) => (
              <ActionTile
                key={action.id}
                {...(action.iconNode !== undefined
                  ? { chip: action.iconNode }
                  : { icon: action.icon })}
                label={action.label}
                {...(action.shortcut ? { value: action.shortcut } : {})}
                onClick={() => {
                  // Same bookkeeping the palette does, so a tool used from here
                  // ranks in the palette's recents too — one action, one history.
                  recordRecent(action.id);
                  action.execute();
                  onAction?.();
                }}
              />
            ))}
          </TileGrid>
        </section>
      ))}

      {onOpenPalette && (
        <section className="tools-panel__group">
          <TileGrid min={150} row={78}>
            <ActionTile
              icon={CommandIcon}
              label="Command palette"
              value="Mod+K"
              hint="Search every action, including ones without a tile."
              wide
              onClick={() => {
                onOpenPalette();
                onAction?.();
              }}
            />
          </TileGrid>
        </section>
      )}
    </div>
  );
}

export default ToolsPanel;
