# Blob-reference Fixtures

Cross-language golden cases for **blob-reference collection**. Loaded by both
the TypeScript suite (`src/storage/AssetBundler.fixtures.test.ts`) and the Rust
relay suite (`relay/src/api.rs#blob_ref_fixture_tests`) so the two walkers
cannot drift.

## Why this exists

The client and the relay each walk a document to decide which blobs it
references. That set drives **garbage collection** — anything it misses is
deleted as an orphan. The two implementations had already diverged once
(JP-494): the relay scanned *inside* strings and so found a prose page's
`<img src="blob://…">`, the client only matched whole strings and so missed
every one of them. The client's doc comment claimed the pair mirrored each
other, which is what made it hard to spot — both files read as correct.

A shared fixture is the only thing that makes that class of drift fail loudly.
Same idea as `../protocol-fixtures/`.

## The contract

Exactly two reference shapes exist. Anything that stores a blob must use one of
them or it is invisible to GC:

1. a raw SHA-256 hash under a key literally named `blobRef` (`FileShape`), or
2. the `blob://<hash>` grammar **anywhere inside a string** (rich-text HTML
   embeds it in an `<img src>`).

A hash is 64 **lowercase** hex characters. The scan accepts a hex run of either
case but the validity check is lowercase-only, so an uppercase hash is
rejected — a case pinned here because those two rules interact.

Over-matching is the safe direction: a stray `blob://` in a code block merely
keeps a blob alive, whereas under-matching deletes bytes.

**A new node type that carries a blob must store shape 2** — a prose attribute
lives inside an HTML string, so shape 1 cannot fire for it. Store
`data-blob-ref="blob://<hash>"`, not a bare hash, or GC, the publish manifest,
and the MCP file tools all silently miss it.

## Format

One JSON file, `cases.json`:

```json
{
  "cases": [
    { "name": "…", "why": "…", "doc": { }, "expected": ["<hash>", "…"] }
  ]
}
```

- `doc` — a document body fragment. Only the keys under test need be present;
  both walkers recurse the whole tree and ignore the rest.
- `expected` — every hash the walk must return, **sorted**. Both suites compare
  sorted sets, so ordering in the file is for readability only.
- `why` — what would break if this case regressed. Keep it concrete.

If you change how either side collects references, add or update a case here.
CI will be red on the other language otherwise — which is the point.
