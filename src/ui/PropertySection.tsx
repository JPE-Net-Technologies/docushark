import { useCallback, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { sectionIconFor } from './propertySectionIcons';
import './PropertySection.css';

/**
 * Props for the PropertySection component.
 */
interface PropertySectionProps {
  /** Unique identifier for the section (used for persistence) */
  id: string;
  /** Section title */
  title: string;
  /** Section content */
  children: ReactNode;
  /** Default expanded state (used if no persisted state exists) */
  defaultExpanded?: boolean;
  /** Optional badge content (e.g., multi-selection count) */
  badge?: string | number;
  /** Optional leading icon (a lucide glyph) shown before the title. */
  icon?: ReactNode;
  /**
   * Optional compact summary of the section's current values, rendered in the
   * header only while the section is COLLAPSED — so collapsing stays informative
   * (e.g. fill/stroke swatches, or "110, 46") instead of just hiding the controls.
   */
  summary?: ReactNode;
}

/**
 * Collapsible property section, rendered as a polished card.
 *
 * Features:
 * - Click / Enter / Space on the header to expand or collapse.
 * - A single chevron that rotates between states (no glyph swap).
 * - Fluid height animation via `grid-template-rows` (no `max-height` clip, so
 *   tall sections like UML members never truncate). Reduced-motion is honored
 *   globally by `adaptive-motion.css`.
 * - Sticky header within the scrolling panel.
 * - Persists expanded state across sessions (keyed by `id`).
 *
 * Usage:
 * ```tsx
 * <PropertySection id="appearance" title="Appearance" icon={<Palette />}>
 *   ...
 * </PropertySection>
 * ```
 */
export function PropertySection({
  id,
  title,
  children,
  defaultExpanded = true,
  badge,
  icon,
  summary,
}: PropertySectionProps) {
  const { isSectionExpanded, toggleSection } = useUIPreferencesStore();

  const isExpanded = isSectionExpanded(id, defaultExpanded);
  const resolvedIcon = icon ?? sectionIconFor(id);

  const handleToggle = useCallback(() => {
    toggleSection(id);
  }, [id, toggleSection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSection(id);
      }
    },
    [id, toggleSection]
  );

  return (
    <div className={`property-section-container ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <div
        className="property-section-header"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={`section-content-${id}`}
      >
        <span className="property-section-chevron" aria-hidden="true">
          <ChevronRight size={14} strokeWidth={2.25} />
        </span>
        {resolvedIcon !== null && resolvedIcon !== undefined && (
          <span className="property-section-icon" aria-hidden="true">
            {resolvedIcon}
          </span>
        )}
        <span className="property-section-title">{title}</span>
        {!isExpanded && summary !== undefined && (
          <span className="property-section-summary">{summary}</span>
        )}
        {badge !== undefined && <span className="property-section-badge">{badge}</span>}
      </div>
      <div
        id={`section-content-${id}`}
        className="property-section-content"
        role="region"
        aria-label={title}
        aria-hidden={!isExpanded}
      >
        <div className="property-section-content-inner">{children}</div>
      </div>
    </div>
  );
}

export default PropertySection;
