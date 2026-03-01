# Icon Integration Plan: Official Cloud Provider Icon Packs

## Overview

Replace hand-crafted SVG icons (which are graphically broken for many icons like Google Cloud, Ubuntu, CSS3) with official icon packs sourced from AWS, Azure, and GCP. The `NEW-ICONS/` directory contains ~2,782 SVGs across 4 icon packs.

### Cloud Provider Icon Licensing
This tool includes official service icons for AWS, Azure, and Google Cloud.
Icons are used **solely for architectural diagrams and technical documentation**, in accordance with each provider’s permitted‑use guidelines.  
All trademarks and rights remain with their respective owners.

## Source Inventory

| Provider | Pack | SVGs | Avg Size | Format | ViewBox |
|----------|------|------|----------|--------|---------|
| AWS | Services (48px) | 302 | 3.4 KB | Colored, `fill` attrs | `0 0 64 64` |
| AWS | Resources (48px) | 421 | 3.2 KB | Colored, `fill` attrs | `0 0 64 64` |
| AWS | Categories (48px) | 26 | — | Category badges | `0 0 64 64` |
| AWS | Groups | 15 | — | Flat, 32px | `0 0 32 32` |
| Azure | Icons | 705 | 2.3 KB | Gradients, 18px | `0 0 18 18` |
| GCP | Modern | 19 | 2.0 KB | Complex, CSS classes | `0 0 512 512` |
| GCP | Legacy | 216 | 1.4 KB | Simple, CSS classes | `0 0 24 24` |
| **Total** | | **~1,704 unique** | | | |

### SVG Format Notes

- **AWS**: XML prologue, `fill="none"` base with colored `<rect>` backgrounds and white `<path>` icons. Sizes baked into `width`/`height` attributes. Well-structured `<g>` groups.
- **Azure**: Inline `<linearGradient>` defs, compact 18×18 viewBox, brand blues/teals. No XML prologue.
- **GCP Legacy**: `<style>` blocks with `.cls-*` classes, Google brand colors (`#4285f4`, `#669df6`, `#aecbfa`). Compact 24×24, ideal as-is.
- **GCP Modern**: 512×512, Adobe Illustrator output, complex. Better to prefer Legacy icons where available and only use Modern for services not in Legacy.

## Architecture Design

### Principle: Lazy-loaded SVG string bundles

Keep the existing lazy-loading architecture (`CATEGORY_LOADERS` + dynamic `import()`) but replace hand-coded SVG strings with SVGs extracted from the official icon packs via a **build-time preprocessing script**.

```
NEW-ICONS/              (raw source — gitignored from dist, kept in repo)
    ├── AWS-Icons/
    ├── Azure-Icons/
    ├── GCP-Icons/
    └── GCP-Legacy-Icons/

scripts/
    └── build-icons.ts   (preprocessing script)

src/storage/icons/       (generated TS files — lazy loaded via dynamic import)
    ├── index.ts          (category registry — unchanged architecture)
    ├── cloudAwsIcons.ts  (generated: AWS services + resources)
    ├── cloudAzureIcons.ts (generated: Azure icons)
    ├── cloudGcpIcons.ts  (generated: GCP legacy + modern)
    ├── ...existing category files...
```

### Build Script: `scripts/build-icons.ts`

Preprocesses raw SVGs into optimized TypeScript icon arrays:

1. **Read** SVGs from `NEW-ICONS/` directories
2. **Normalize** all SVGs:
   - Strip XML prologue (`<?xml ...?>`)
   - Normalize viewBox to consistent format
   - Strip `width`/`height` attributes (rely on viewBox only)
   - Remove `.DS_Store` and non-SVG files
   - Optionally strip comments and unnecessary whitespace
3. **Categorize** by provider and service category (using folder structure)
4. **Generate** TypeScript files matching `BuiltinIcon[]` format
5. **Name extraction**: derive human-readable names from filenames
   - AWS: `Arch_AWS-Lambda_48.svg` → `"AWS Lambda"`
   - Azure: `10021-icon-service-Virtual-Machine.svg` → `"Virtual Machine"`
   - GCP: `cloud_functions.svg` → `"Cloud Functions"`

### Category Structure (Updated)

Keep existing lazy categories but with dramatically more icons per category:

| Category ID | Source | Est. Icons | Bundle Size |
|------------|--------|------------|-------------|
| `cloud-aws` | AWS Services 48px + Resources 48px | ~723 | ~2.3 MB raw, ~400 KB gzip |
| `cloud-azure` | Azure Icons | ~705 | ~1.6 MB raw, ~250 KB gzip |
| `cloud-gcp` | GCP Legacy + Modern merged | ~235 | ~300 KB raw, ~60 KB gzip |
| `devops` | Keep existing + augment from packs | ~20-30 | ~50 KB |
| `databases` | Keep existing + augment from packs | ~20-30 | ~50 KB |
| `languages` | Keep `simple-icons` sourced | ~20 | ~40 KB |
| `frameworks` | Keep `simple-icons` sourced | ~20 | ~40 KB |

### Sub-Category Splitting (for large providers)

AWS has 723+ icons — too many to browse in one tab. Split into sub-categories matching the folder structure:

```
cloud-aws-compute       (Arch_Compute + Res_Compute)
cloud-aws-storage       (Arch_Storage + Res_Storage)
cloud-aws-databases     (Arch_Databases + Res_Databases)
cloud-aws-networking    (Arch_Networking-Content-Delivery + Res_...)
cloud-aws-security      (Arch_Security-Identity + Res_...)
cloud-aws-analytics     (Arch_Analytics + Res_Analytics)
cloud-aws-containers    (Arch_Containers + Res_Containers)
cloud-aws-ai            (Arch_Artificial-Intelligence + Res_...)
cloud-aws-devtools      (Arch_Developer-Tools + Res_...)
cloud-aws-other         (remaining categories merged)
```

Similarly for Azure:
```
cloud-azure-compute     (compute)
cloud-azure-networking  (networking)
cloud-azure-databases   (databases)
cloud-azure-identity    (identity)
cloud-azure-general     (general)
cloud-azure-other       (remaining merged)
```

GCP stays as one category (`cloud-gcp`) since it has ~235 icons total.

### IconTypes.ts Changes

Add new sub-categories to `IconCategory` type and `LAZY_ICON_CATEGORIES` array. Each sub-category gets its own dynamic `import()` chunk, keeping initial load to zero.

## Bundle Size Strategy

### Target: Zero impact on initial load

- All cloud icons are **lazy-loaded via dynamic `import()`** — Vite creates separate chunks
- Initial bundle: **0 KB added** (icons only load when user clicks category tab)
- Per-category lazy chunk sizes (estimated gzipped):
  - AWS sub-category: ~30-60 KB each
  - Azure sub-category: ~30-50 KB each
  - GCP: ~60 KB total

### Optional: Further Optimization

- **SVGO optimization** in build script to strip unnecessary attributes, minify paths
- **SVG sprite approach**: Store only `<path>` data + metadata, reconstruct `<svg>` wrapper at render time (saves repeated `<svg>` boilerplate)
- **Path-only storage**: For icons that are single `<path>` elements, store just the `d` attribute string

## Backwards Compatibility

### Icon ID Mapping

Current icons use IDs like `builtin:aws-lambda`. The new icons from official packs will use the same format. A migration map handles renamed icons:

```typescript
const ICON_ID_MIGRATIONS: Record<string, string> = {
  'builtin:aws': 'builtin:aws',           // keep
  'builtin:aws-ec2': 'builtin:aws-ec2',   // keep
  'builtin:google-cloud': 'builtin:google-cloud', // keep, better SVG
  // ... old manual IDs → new official IDs
};
```

Icons that existed in the old manual set must keep their IDs or have a migration entry. New icons from official packs get new IDs derived from their names.

### Document Safety

- Old icon IDs continue to work (migration map resolves them)
- If an icon ID is not found, fall back to a placeholder (existing behavior)
- No document format changes needed — icons are referenced by string ID

## Workplan

### Phase 1: Build Script & SVG Processing
- [ ] Create `scripts/build-icons.ts` preprocessing script
- [ ] Implement SVG normalization (strip prologue, normalize viewBox, strip width/height)
- [ ] Implement name extraction from filenames per provider convention
- [ ] Implement category mapping from folder structure
- [ ] Add SVGO optimization pass (optional, can defer)
- [ ] Add `build:icons` task to `Taskfile.yml` / `package.json`

### Phase 2: Category & Type Updates
- [ ] Add AWS/Azure sub-categories to `IconCategory` type in `IconTypes.ts`
- [ ] Add sub-categories to `LAZY_ICON_CATEGORIES` and `ICON_CATEGORY_LABELS`
- [ ] Update `CATEGORY_LOADERS` in `icons/index.ts` with new sub-category imports

### Phase 3: Generate Icon Files
- [ ] Run build script to generate new `cloudAws*.ts`, `cloudAzure*.ts`, `cloudGcp*.ts` files
- [ ] Verify generated files compile and match `BuiltinIcon[]` type
- [ ] Verify lazy loading works for each new sub-category

### Phase 4: Icon Picker UI Updates
- [ ] Update `IconPicker.tsx` to handle sub-categories (grouped tabs or collapsible sections)
- [ ] Add provider grouping in category tabs (AWS ▸ Compute | Storage | ..., Azure ▸ ..., GCP)
- [ ] Test scrolling/performance with 700+ icons in a single category view

### Phase 5: Backwards Compatibility & Cleanup
- [ ] Build icon ID migration map (old manual IDs → new official IDs)
- [ ] Add migration logic to `getBuiltinIcon()` and `loadIconData()`
- [ ] Remove old hand-crafted SVG content from current icon files (keep file structure)
- [ ] Add `NEW-ICONS/` to `.gitignore` for dist builds (keep in repo as source)
- [ ] Verify existing documents with old icon IDs still render correctly

### Phase 6: Testing & Polish
- [ ] Test lazy loading performance (time to load each category)
- [ ] Test icon rendering quality across all providers
- [ ] Test dark mode rendering (currentColor vs. fixed colors)
- [ ] Test icon search across all loaded categories
- [ ] Verify bundle size impact (check Vite build output)

## Open Questions

1. **Color handling**: Official icons use brand colors (not `currentColor`). Should we:
   - (a) Keep brand colors as-is (most accurate, but won't theme with dark/light mode)
   - (b) Replace fills with `currentColor` (themeable, but loses brand identity)
   - (c) Hybrid: show brand colors in picker, use `currentColor` on canvas (configurable per icon)

2. **AWS Services vs Resources**: Should we merge them into combined sub-categories (e.g., all Compute icons together) or keep them separate (Services | Resources)?

3. **GCP Modern vs Legacy**: Modern icons are 512×512 and complex. Should we prefer Legacy (24×24, simpler) for all overlapping services and only use Modern for the ~3-4 services not in Legacy?

4. **Sub-category granularity**: Is splitting AWS into 10 sub-categories too many tabs? Consider a hierarchical picker (provider → category → icons) instead of flat tabs.
