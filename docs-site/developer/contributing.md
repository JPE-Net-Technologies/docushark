# Contributing

We welcome contributions of all kinds — bug fixes, new shape libraries, documentation improvements, and feature work.

## Quick Start

1. Fork the repository on [GitHub](https://github.com/QR-Madness/diagrammer)
2. Clone your fork and set up the dev environment (see [Project Setup](./project-setup))
3. Create a feature branch: `git checkout -b my-feature`
4. Make your changes
5. Run checks: `task check` (or `bun run typecheck && bun run test --run`)
6. Commit and push
7. Open a pull request against `master`

## Code Style

Diagrammer follows these conventions — CI will catch violations, but knowing them upfront saves time:

### TypeScript

| Rule | Rationale |
|------|-----------|
| **No `any` types** | Use `unknown` with type guards instead |
| **Immutable updates** | All state mutations go through Immer |
| **Pure functions** | Shape handlers and math utilities should have no side effects |
| **Small, focused files** | One clear responsibility per file |
| **Explicit over clever** | Verbose, readable code beats clever one-liners |

### Rust

The Tauri backend follows standard Rust conventions — `cargo fmt` and `cargo clippy` should pass cleanly.

### Comments

Only comment code that needs clarification. Don't comment the obvious. Good function and variable names should make intent clear.

## What to Work On

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/QR-Madness/diagrammer/labels/good%20first%20issue) on GitHub.

### Shape Libraries

Adding new shape libraries is one of the easiest ways to contribute. Library shapes use a declarative approach — you define geometry with a `PathBuilder` function, and the framework generates all handler methods automatically:

1. Create a new file under `/src/shapes/library/` (e.g., `myShapes.ts`)
2. Define shapes using `LibraryShapeDefinition` with a `pathBuilder` function that returns a `Path2D`
3. Add `ShapeMetadata` (name, category, icon, property definitions) for the PropertyPanel
4. Define anchor points for connectors
5. Export as an array and add a lazy loader in `shapeLibraryStore.ts`
6. Add tests for hit testing, bounds, and anchors

See the [Creating Shapes](./creating-shapes) guide for a complete walkthrough with examples.

### Documentation

Documentation lives in `/docs-site/`. It uses [VitePress](https://vitepress.dev). Run the docs locally:

```bash
cd docs-site
bun install
bun run dev
```

## Testing Requirements

All pull requests must pass:

1. **TypeScript type checking** — `bun run typecheck`
2. **All existing tests** — `bun run test --run`
3. **Rust compilation** — `cargo check --manifest-path src-tauri/Cargo.toml`

### Writing Tests

- Test files go alongside their source file with `.test.ts` suffix
- Use Vitest globals (`describe`, `it`, `expect`) — no imports needed
- **Always test math** — geometry, coordinate, and transform functions require thorough unit tests
- Test stores by verifying state transitions, not internal implementation

```typescript
describe('MyFeature', () => {
  it('should do the expected thing', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

## Architecture Decisions

Before making significant architectural changes, please open an issue to discuss. Key constraints to keep in mind:

- **Canvas rendering is not React** — don't introduce React into the render loop
- **Shapes are data, not classes** — the ShapeRegistry pattern is intentional
- **DocumentStore is the single source of truth** — don't cache shape data elsewhere
- **Camera owns all coordinate math** — never manually apply pan/zoom

See [Architecture](./architecture) and [Core Systems](./core-systems) for deeper context.

## Commit Messages

Use conventional-ish commit messages:

```
feat: add swimlane shape to UML library
fix: connector routing ignores rotated shapes
docs: update collaboration setup guide
test: add tests for SpatialIndex edge cases
refactor: extract connector routing into separate module
```

::: tip
Found a bug or have a feature request? Open an issue on GitHub — even if you're not planning to fix it yourself.
:::
