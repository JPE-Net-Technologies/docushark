/**
 * Shortcut category type — the grouping axis shared by the command registry and
 * the shortcut help panel.
 *
 * NOTE: the actual shortcut definitions live in the central command registry
 * (`CommandRegistry.ts`), which is the single source of truth that both the
 * command palette and the help panel render from. The old hardcoded
 * `KEYBOARD_SHORTCUTS` array was retired (it drifted from the real handlers).
 */
export type ShortcutCategory =
  | 'Tools'
  | 'Navigation'
  | 'Editing'
  | 'File'
  | 'View';
