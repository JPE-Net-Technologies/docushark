# Vendored dependencies

## yrs 0.26.0 (`vendor/yrs`)

Verbatim copy of the `yrs` 0.26.0 crate from crates.io (MIT, per its
`Cargo.toml` `license` field), wired in via `[patch.crates-io]` in
`relay/Cargo.toml`, carrying exactly **one change**:

- `src/branch.rs`, `Branch::insert_at`: an index-0 insert now anchors the new
  item's **right origin to the current head** (`(None, start)`), matching the
  yjs reference implementation. Upstream creates the item unanchored
  (`(None, None)`), so on integration YATA's client-id tiebreak decides its
  position instead of the requested index — a client whose id is larger than
  the head item's creator sees its prepend land *after* the head. Present in
  upstream 0.26.0 through 0.27.2 (latest at vendoring time). Grep for
  `DOCUSHARK PATCH` to find the change.

Observable relay-side symptom before the patch: `docushark_insert_block` with
`side: "before"` targeting the first block (and any structural verb inserting
at index 0) silently placed content one slot too low on live, hydrated
documents. Regression coverage:
`sync::prose_block::tests::insert_before_survives_reintegration_with_foreign_seed_lineage`.

**Remove this vendored copy** (and the `[patch.crates-io]` entry, and the
Dockerfile `COPY vendor ./vendor` line) once an upstream yrs release ships the
fix and the relay has upgraded to it.
