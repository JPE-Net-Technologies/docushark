/**
 * Central keyboard shortcut registry.
 *
 * Collects all shortcut definitions for display in the shortcut reference panel.
 * Shortcuts are organized by category.
 */

export interface ShortcutEntry {
  /** Display label for the key combination */
  keys: string;
  /** Description of the action */
  description: string;
  /** Category for grouping */
  category: ShortcutCategory;
}

export type ShortcutCategory =
  | 'Tools'
  | 'Navigation'
  | 'Editing'
  | 'File'
  | 'View';

/**
 * All registered keyboard shortcuts in the application.
 */
export const KEYBOARD_SHORTCUTS: ShortcutEntry[] = [
  // Tools
  { keys: 'V', description: 'Select tool', category: 'Tools' },
  { keys: 'R', description: 'Rectangle tool', category: 'Tools' },
  { keys: 'O', description: 'Ellipse tool', category: 'Tools' },
  { keys: 'L', description: 'Line tool', category: 'Tools' },
  { keys: 'C', description: 'Connector tool', category: 'Tools' },
  { keys: 'T', description: 'Text tool', category: 'Tools' },
  { keys: 'H', description: 'Pan (Hand) tool', category: 'Tools' },

  // Navigation
  { keys: 'W / A / S / D', description: 'Pan canvas', category: 'Navigation' },
  { keys: '↑ / ↓ / ← / →', description: 'Nudge shapes (or pan if none selected)', category: 'Navigation' },
  { keys: 'Shift + Arrow', description: 'Nudge by 50px', category: 'Navigation' },
  { keys: 'Q', description: 'Zoom out', category: 'Navigation' },
  { keys: 'E', description: 'Zoom in', category: 'Navigation' },
  { keys: 'Scroll wheel', description: 'Zoom at cursor', category: 'Navigation' },

  // Editing
  { keys: 'Ctrl+Z', description: 'Undo', category: 'Editing' },
  { keys: 'Ctrl+Shift+Z / Ctrl+Y', description: 'Redo', category: 'Editing' },
  { keys: 'Ctrl+A', description: 'Select all', category: 'Editing' },
  { keys: 'Ctrl+C', description: 'Copy', category: 'Editing' },
  { keys: 'Ctrl+V', description: 'Paste', category: 'Editing' },
  { keys: 'Ctrl+G', description: 'Group selected shapes', category: 'Editing' },
  { keys: 'Ctrl+Shift+G', description: 'Ungroup', category: 'Editing' },
  { keys: 'Ctrl+Shift+A', description: 'Select connected shapes (chain)', category: 'Editing' },
  { keys: 'Ctrl+Shift+L', description: 'Auto-layout selection', category: 'Editing' },
  { keys: 'Delete / Backspace', description: 'Delete selected', category: 'Editing' },
  { keys: 'Escape', description: 'Clear selection', category: 'Editing' },

  // File
  { keys: 'Ctrl+N', description: 'New document', category: 'File' },
  { keys: 'Ctrl+O', description: 'Open document', category: 'File' },
  { keys: 'Ctrl+S', description: 'Save', category: 'File' },
  { keys: 'Ctrl+Shift+E', description: 'Export as PNG', category: 'File' },

  // View
  { keys: '?', description: 'Keyboard shortcuts', category: 'View' },
  { keys: 'Ctrl+K', description: 'Command palette', category: 'View' },
  { keys: 'Ctrl+F', description: 'Search shapes', category: 'View' },
  { keys: 'Ctrl+I', description: 'Toggle whiteboard (Ideas)', category: 'View' },
  { keys: 'Ctrl+Shift+1', description: 'Switch to Relaxed layout', category: 'View' },
  { keys: 'Ctrl+Shift+2', description: 'Switch to Designer layout', category: 'View' },
  { keys: 'Ctrl+Shift+3', description: 'Switch to Technician layout', category: 'View' },
  { keys: 'Ctrl+Shift+4', description: 'Switch to Power layout', category: 'View' },
];

/**
 * Get shortcuts grouped by category.
 */
export function getShortcutsByCategory(): Map<ShortcutCategory, ShortcutEntry[]> {
  const map = new Map<ShortcutCategory, ShortcutEntry[]>();
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    const list = map.get(shortcut.category) ?? [];
    list.push(shortcut);
    map.set(shortcut.category, list);
  }
  return map;
}
