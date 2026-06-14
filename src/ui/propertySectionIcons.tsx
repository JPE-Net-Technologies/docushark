import type { ReactNode } from 'react';
import {
  Anchor,
  Box,
  Braces,
  Diamond,
  File,
  Group,
  List,
  Layers,
  Move,
  Network,
  PaintBucket,
  Palette,
  Rows3,
  Ruler,
  SlidersHorizontal,
  Spline,
  Sparkles,
  Square,
  Tag,
  Type,
  Workflow,
} from 'lucide-react';

/**
 * Maps a {@link PropertySection} `id` to a small lucide glyph, so the panel's
 * groups are scannable at a glance. Kept out of `PropertySection.tsx` so the
 * section component stays presentation-only; the section resolves its icon from
 * here by id, and any call site can still override via the `icon` prop.
 *
 * Unmapped ids fall back to `null` (no icon) rather than a misleading generic.
 */
const SECTION_ICONS: Record<string, ReactNode> = {
  appearance: <Palette size={14} strokeWidth={2} />,
  label: <Tag size={14} strokeWidth={2} />,
  text: <Type size={14} strokeWidth={2} />,
  position: <Move size={14} strokeWidth={2} />,
  size: <Ruler size={14} strokeWidth={2} />,
  dimensions: <Ruler size={14} strokeWidth={2} />,
  icon: <Sparkles size={14} strokeWidth={2} />,
  custom: <SlidersHorizontal size={14} strokeWidth={2} />,

  // Connectors
  'connector-routing': <Spline size={14} strokeWidth={2} />,
  'connector-type': <Workflow size={14} strokeWidth={2} />,
  'connector-label': <Tag size={14} strokeWidth={2} />,
  'connector-cardinality': <Network size={14} strokeWidth={2} />,
  'connector-endpoints': <Anchor size={14} strokeWidth={2} />,
  'uml-markers': <Diamond size={14} strokeWidth={2} />,
  endpoints: <Anchor size={14} strokeWidth={2} />,

  // ERD
  'erd-entity': <Box size={14} strokeWidth={2} />,
  'erd-members': <List size={14} strokeWidth={2} />,
  'erd-table-style': <PaintBucket size={14} strokeWidth={2} />,

  // UML
  'uml-class': <Box size={14} strokeWidth={2} />,
  'uml-attributes': <List size={14} strokeWidth={2} />,
  'uml-methods': <Braces size={14} strokeWidth={2} />,

  // Swimlane
  'swimlane-lanes': <Rows3 size={14} strokeWidth={2} />,

  // File
  'file-info': <File size={14} strokeWidth={2} />,
  'file-label': <Tag size={14} strokeWidth={2} />,

  // Group
  group: <Group size={14} strokeWidth={2} />,
  'group-background': <PaintBucket size={14} strokeWidth={2} />,
  'group-border': <Square size={14} strokeWidth={2} />,
  'group-label': <Tag size={14} strokeWidth={2} />,
  'group-shadow': <Layers size={14} strokeWidth={2} />,
};

/** Resolve the icon for a section id, or `null` if none is mapped. */
export function sectionIconFor(id: string): ReactNode {
  return SECTION_ICONS[id] ?? null;
}
