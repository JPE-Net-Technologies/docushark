/**
 * Shared lucide-react icon conventions for editor chrome.
 *
 * Use these instead of re-declaring a local `const ICON` per toolbar so every
 * chrome icon shares one size + stroke. Spread the token onto a lucide glyph
 * (`<Bold {...ICON} />`) or use the `Icon` wrapper (`<Icon icon={Bold} />`).
 *
 * This is the single source of truth for icon sizing (JP-219 / JP-220). The
 * remaining inline `size=/strokeWidth=` call sites migrate onto it over the
 * later icon-unification slices.
 */
import type { LucideIcon, LucideProps } from 'lucide-react';

/** Canonical chrome icon: 16px glyph, 1.5 stroke. */
export const ICON = { size: 16, strokeWidth: 1.5 } as const;

/** Dense variant for inline affordances (chevrons, small badges): 12px. */
export const ICON_SM = { size: 12, strokeWidth: 1.5 } as const;

/**
 * Renders a lucide icon with the canonical chrome defaults. Any lucide prop
 * (`size`, `strokeWidth`, `className`, …) overrides the default.
 */
export function Icon({ icon: Glyph, ...props }: { icon: LucideIcon } & LucideProps) {
  return <Glyph size={ICON.size} strokeWidth={ICON.strokeWidth} {...props} />;
}
