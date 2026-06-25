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

/**
 * Custom "PDF" glyph (JP-357) — a page with a folded corner and a knockout
 * "PDF" label band, so the export button reads literally rather than as a
 * generic file-down arrow. Matches the lucide chrome aesthetic (currentColor,
 * 16px / 1.5 stroke). The label letters are filled with the panel background so
 * they read in both themes against the opaque currentColor band.
 */
export function PdfIcon({ size = ICON.size, strokeWidth = ICON.strokeWidth, ...rest }: LucideProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <rect x="6.5" y="12.5" width="11" height="6" rx="1" fill="currentColor" stroke="none" />
      <text
        x="12"
        y="17.1"
        textAnchor="middle"
        fontSize="4.6"
        fontWeight="700"
        stroke="none"
        fill="var(--bg-secondary, #fff)"
        fontFamily="system-ui, sans-serif"
      >
        PDF
      </text>
    </svg>
  );
}
