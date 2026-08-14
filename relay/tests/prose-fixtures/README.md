# Prose Round-Trip Fixtures

Cross-language golden cases for the **prose document model**. Loaded by both the
Rust relay suite (`relay/src/sync/prose_fixture_tests.rs`) and the TypeScript
editor suite (`src/ui/proseFixtures.test.ts`) so the two prose implementations
cannot drift.

Same idea as `../blob-ref-fixtures/` and `../protocol-fixtures/`.

## Why this exists

Adding one inline node (`fileRef`, JP-495) required touching **six** relay sites
that enumerate node types by name. The plan listed four. The two that were missed
— `prose_validate::is_known_type` and `is_atom` — were caught only because
round-trip tests happened to get written by hand. Missing the first one **deleted
the node outright**: an unknown type unwraps to its children, and an atom has
none.

`src/ui/proseSchemaContract.test.ts` stayed green through all of it, because it
checks the **manifest** — which node names, marks and attrs each side declares —
not the **behaviour** on a real document. This corpus is that missing layer.

The same shape recurs in this codebase's history: JP-468/472/473 (the
"second-renderer defect class"), JP-330 (shapeOrder doubling), JP-338 (prose body
doubling), JP-494 (four blob walkers, one correct). In each, two implementations
of one contract drifted and nothing failed loudly.

It earned its place immediately: its first run found `mathInline` and `mathBlock`
parsing to an **empty** `latex` on the client. The node survived, the formula did
not — the attribute had no explicit `parseHTML`, so Tiptap's default looked for
an attribute literally named `latex` while both sides write `data-latex`. Live
collaboration was unaffected (the Y.Doc carries attrs directly), so it only bit
the paths that re-parse stored HTML: PDF export, the mirror service,
version-history preview, and any non-collaborative open.

## What is compared — and what deliberately is not

**The document model**: the node sequence and the attribute values. Not HTML
text.

HTML legitimately differs between the two sides. The relay stores a canonical
form; the editor renders with presentation classes (`tiptap-image`,
`prose-gallery`), node-view chrome (`contenteditable`, the task-list checkbox
`<label><input>`), a DOM-minted `<tbody>`, and its own attribute order. Pinning
the editor's HTML would assert mostly chrome, break on any Tiptap upgrade, and
train maintainers to paste in whatever the editor now emits — which is precisely
how a real regression gets blessed as expected.

HTML **is** pinned on the relay side, where it belongs: HTML is the relay's
storage format, so `html` must be a byte-identical fixed point through the seed
path, the replace path, and a second pass.

## Format

```json
{
  "atoms": ["fileRef", "…"],
  "cases": [
    {
      "name": "…",
      "why": "…",
      "html": "…",
      "nodes": [{ "type": "fileRef", "attrs": { "blobRef": "blob://…" } }]
    }
  ]
}
```

- `html` — the **canonical stored form**: what the relay serializes, already
  normalized (no checkbox chrome, no `colspan="1"`). Both sides parse this.
- `nodes` — the document model in document order, text nodes excluded. The type
  sequence must match **exactly**; `attrs` is a **subset** check.
- `why` — what breaks if this case regresses. Concrete, and printed in the
  failure message.
- `atoms` — node types both sides must treat as childless atoms.

### Two deliberate looseness choices

**Attrs are a subset match** because the client materializes schema defaults the
relay omits — `colspan="1"`, a `<th>`'s `scope="col"`. Neither side is wrong, and
declaring the payload attrs while ignoring defaults lets one manifest serve both
without per-side carve-outs.

**Attr values are compared as strings.** The client stores `colspan` as a number
and `colwidth` as an array where the relay has strings; `String([100,120])` is
`"100,120"`, which is also the Tiptap wire form.

## The `atoms` list, and why it lives here

An atom that illegally keeps its children **still serializes to byte-identical
HTML** — the serializer writes the text child from an attribute either way — so
no round-trip assertion can see the defect. It surfaces downstream as a client
NodeView crash ("Cannot read properties of undefined (reading 'children')"),
after which y-prosemirror deletes the node.

The list is declared here rather than read out of either implementation because
the first version of that test asked `prose_validate::is_atom` which nodes to
check. Deleting an entry from `is_atom` then made the test **skip** the check
instead of failing it — a guard that asserted nothing while looking thorough.
An independent source of truth is the whole point.

## Coverage guards

Two tests keep the corpus from silently going hollow:

- every `CUSTOM_PROSE_NODES` entry must appear in at least one case, so a new
  custom node cannot be added without a fixture;
- every declared atom must appear in at least one case's parsed tree, so the
  childless assertion cannot pass by never visiting the node.

## Adding a case

Add it here, then run both suites — a case that only one side satisfies is the
drift this file exists to surface.

```bash
cargo test --manifest-path relay/Cargo.toml --locked --lib sync::prose_fixture_tests
bun run test --run src/ui/proseFixtures.test.ts
```

**Verify the new case can fail.** Break the behaviour it covers and watch it go
red before trusting it. Three guards written during JP-495 passed while asserting
nothing, and a fourth (the atoms check above) did the same during JP-496.
