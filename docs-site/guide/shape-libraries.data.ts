import { fileURLToPath } from 'node:url';
import { defineLoader } from 'vitepress';
import { flowchartShapes } from '../../src/shapes/library/flowchartShapes';
import { erdShapes } from '../../src/shapes/library/erdShapes';
import { umlClassShapes } from '../../src/shapes/library/umlClassShapes';
import { umlUseCaseShapes } from '../../src/shapes/library/umlUseCaseShapes';
import { sequenceDiagramShapes } from '../../src/shapes/library/sequenceDiagramShapes';
import { activityDiagramShapes } from '../../src/shapes/library/activityDiagramShapes';
import { buildCatalog } from '../../scripts/gen-icon-catalog';
import { ICON_CATEGORY_LABELS, type IconCategory } from '../../src/storage/IconTypes';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const LIBRARY_GROUPS: Array<{
  category: string;
  label: string;
  description: string;
  shapes: Array<{ metadata: { name: string; description?: string } }>;
}> = [
  {
    category: 'flowchart',
    label: 'Flowchart',
    description: 'Standard flowchart symbols for process diagrams.',
    shapes: flowchartShapes,
  },
  {
    category: 'erd',
    label: 'ERD (Entity-Relationship)',
    description: "Database modeling shapes in Crow's Foot notation.",
    shapes: erdShapes,
  },
  {
    category: 'uml-class',
    label: 'UML Class Diagrams',
    description: 'Class, interface, and package shapes for software design.',
    shapes: umlClassShapes,
  },
  {
    category: 'uml-usecase',
    label: 'UML Use Case Diagrams',
    description: 'Actors, use cases, and system boundaries.',
    shapes: umlUseCaseShapes,
  },
  {
    category: 'uml-sequence',
    label: 'UML Sequence Diagrams',
    description: 'Lifelines, activations, and interaction fragments.',
    shapes: sequenceDiagramShapes,
  },
  {
    category: 'uml-activity',
    label: 'UML Activity Diagrams',
    description: 'Actions, decisions, and swimlanes for workflow modeling.',
    shapes: activityDiagramShapes,
  },
];

export interface ShapeManifestData {
  libraryShapeCount: number;
  libraryCategories: Array<{
    category: string;
    label: string;
    description: string;
    count: number;
    shapes: Array<{ name: string; description: string }>;
  }>;
  iconCount: number;
  iconCategories: Array<{ category: string; label: string; count: number }>;
}

export default defineLoader({
  async load(): Promise<ShapeManifestData> {
    const libraryCategories = LIBRARY_GROUPS.map((group) => ({
      category: group.category,
      label: group.label,
      description: group.description,
      count: group.shapes.length,
      shapes: group.shapes.map((s) => ({
        name: s.metadata.name,
        description: s.metadata.description ?? '',
      })),
    }));

    // gen-icon-catalog.ts's internal path resolution is intentionally anchored to
    // process.cwd() (see its `rel()` helper) rather than import.meta.url, since
    // vitest rewrites import.meta.url for that file's own drift test. A VitePress
    // build's cwd is docs-site/, not the repo root where public/icons/ lives, so
    // we relocate for the duration of this call and always restore afterward.
    const previousCwd = process.cwd();
    let catalog;
    try {
      process.chdir(REPO_ROOT);
      catalog = await buildCatalog({ allowMissingManifests: true });
    } finally {
      process.chdir(previousCwd);
    }

    const countsByCategory = new Map<string, number>();
    for (const icon of catalog.icons) {
      countsByCategory.set(icon.category, (countsByCategory.get(icon.category) ?? 0) + 1);
    }
    const iconCategories = [...countsByCategory.entries()]
      .map(([category, count]) => ({
        category,
        label: ICON_CATEGORY_LABELS[category as IconCategory] ?? category,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      libraryShapeCount: libraryCategories.reduce((sum, c) => sum + c.count, 0),
      libraryCategories,
      iconCount: catalog.count,
      iconCategories,
    };
  },
});
