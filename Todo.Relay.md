# Todo.Relay.md — phase 20.3 v2 functional checklist

Handoff for the next agent. The `v2` branch ships
**Diagrammer 2.0.0-beta.1**: the collaboration / MCP / auth / storage
concerns extract out of the Tauri host into a standalone
`diagrammer-relay` binary, and the Tauri desktop becomes a pure
client.

This file is the path from *current state* to *functional v2 build*,
excluding debugging, polish, performance, and release-notes work.
The wider plan lives in `Todo.md`; this file is the operator-level
view of what's left.

---

## Decisions already made (do not relitigate)

These were settled in the planning session that produced this file.
The next agent should treat them as load-bearing.

1. **Default relay URL in the renderer is pre-filled** with
   `http://localhost:9876`. Custom-URL UX is deferred.
2. **No credential persistence in v2.** Show a login screen each
   launch; cached-creds-with-silent-relogin is a polish item.
3. **Single port for the sync listener.** The current shape
   (`/ws?doc=<id>` on port 9876, MCP on 9877) already satisfies the
   "one consolidated deployment endpoint" goal. Do **not** restructure
   to `/sync/:doc_id` purely for cosmetics — that's churn without
   functional gain. Keep the existing query-param shape.
4. **Defer argon2.** Bcrypt stays for v2. Not a security blocker; the
   swap is symbolic.
5. **Rename `'to-team'` direction enum (`DocumentTransferService`)
   to `'to-relay'`** in v2. Team functionality *is* severed in v2 —
   every relay document is a relay document, no special-case team
   docs — so the rename is safe.
6. **Rename `DocumentMetadata.isTeamDocument` wire field → `isRelayDocument`**
   on the same justification as #5. Bumps `PROTOCOL_VERSION` to 2.
   Update fixtures, both protocol.rs files, and the migration that
   reads beta-era data files. Worth doing precisely because team
   functionality is severed — the field would otherwise be a
   misleading vestige.
7. **The relay is never embedded in the Tauri app.** Users run it
   separately (locally, behind Tailscale / Cloudflare Tunnel, or
   eventually a managed tier). No "be a host" UX in the desktop;
   that affordance disappears entirely.

---

## State of the v2 branch when this file was written

12 commits ahead of master on `v2`. What's done:

| Slice | Status | Headline |
|-------|--------|----------|
| A | shipped | `PROTOCOL_VERSION = 1`, 18 cross-language fixtures, round-trip tests on both sides. |
| B | shipped | Renderer renamed `team*` / "Protected Local" → `relay*`; localStorage migration on first v2 boot. |
| C | shipped | `/relay/` crate exists; `server` + `auth` + `mcp` lifted from src-tauri; `relay serve` runs end-to-end. |
| D.1 | shipped | TOML config schema; `relay init` rolls a fresh 32-byte JWT secret. |
| D.2 | shipped | MCP endpoint wired into `relay serve` (parity with old Tauri). |
| D.3 | shipped | Additive REST endpoints: `/api/auth/{register,login,me}` + `/api/docs/*`. |
| E.1 | shipped | TS `RelayClient` (`src/api/relayClient.ts`) + 16 unit tests. |
| E.2 | shipped | WS now pure CRDT/awareness/auth-validation; CRUD + login speak REST via `RestDocumentProvider`; JWT persistence + 401 toast. Three commits: `300027d`, `26912d8`, `140dee1`. |
| E.5 | shipped | Relay tab in Settings; deleted `useRelayStore`, `AuthGuard`, `LoginPage`, `CollaborationSettings`, `ClientConnectionPanel`, `RelayMembersManager`; `DocumentPermissionsDialog` rewired to free-text user input. Two commits: `c135456`, `c9f853f`. |
| E.4 | shipped | `rm -rf src-tauri/src/{server,mcp,auth}/`; `lib.rs` slimmed from 897→160 LOC (only `open_docs` remains); Cargo deps trimmed (only `axum`+`tower-http` kept, narrowly scoped to the docs server); renderer-side: deleted `McpSettings` tab, mcp wrappers, `mcpMirror` calls; `userStore` became a 60-line facade over `useConnectionStore.user`; `src/tauri/commands.ts` trimmed 273→33 LOC. |
| E.3 | shipped | WS protocol slimmed to SYNC/AWARENESS/AUTH/AUTH_RESPONSE/JOIN_DOC/DOC_EVENT/ERROR. Deleted `MESSAGE_DOC_*` constants + `AUTH_LOGIN`, the corresponding Rust handlers (`handle_doc_*`, `handle_auth_login`), TS request/response interfaces (`DocList*`/`DocGet*`/`DocSave*`/`DocDelete*`/`DocShare*`/`DocTransfer*`), 13 fixture files, and the routing helpers (`getMessageChannel`, `isAuthMessage`, `isDocumentMessage`, `isRequestMessage`). Byte slots 3–6 + 11–13 reserved. Relay smoke (6) + TS protocol fixtures (12) + Rust fixture round-trip still pass. |
| G | shipped | Dockerfile, systemd unit, README, 3-test smoke suite. |

What's *known broken or vestigial*:

- `src-tauri/src/mcp/tools.rs` carries a WIP `change_detail` field
  populated as `None` everywhere — MCP still works for reads but
  writes don't propagate change deltas. Acceptable: MCP-on-Tauri
  goes away entirely in **E.4** below.
- `src-tauri/src/{server,mcp,auth}/` are duplicated in `/relay/src/`.
  Both compile. They're kept until **E.4** to keep Tauri buildable
  during the renderer migration.
- The Tauri desktop still tries to embed a WS server when the user
  toggles "Protected Local" in Settings. Renderer migration (**E.2 +
  E.5**) is what removes that.

---

## Work remaining, in dependency order

### Pre-flight (small, no decisions blocking)

- [x] **`User.org_id: Option<String>`** plumbed through `User` struct
      and `users.json` serde. Single `"default"` org constant for now.
      Plan-mandated future-proofing. Trivial.

### Wire-protocol rename (decisions #5–#6)

- [x] **Bump `PROTOCOL_VERSION` to 2** in `src/collaboration/protocol.ts`
      *and* `relay/src/server/protocol.rs` *and* `src-tauri/src/server/protocol.rs`.
- [x] **Rename `DocumentMetadata.isTeamDocument` → `isRelayDocument`**
      on both the TS interface (`src/types/Document.ts`) and the Rust
      structs (`relay/src/server/documents.rs`,
      `src-tauri/src/server/documents.rs`). camelCase serde handles
      the JSON binding.
- [x] **Update fixtures**: `relay/tests/protocol-fixtures/05_doc_list_response.json`
      and `12_doc_event.json` carry the old field name. Edit both.
- [x] **Update `DocumentTransferService`** TS-side: rename
      `TransferDirection` `'to-team' | 'to-personal'` → `'to-relay' | 'to-personal'`
      and every consumer.
- [x] **Boot migration**: extend `src/migrations/relayRename.ts` to
      rewrite stored docs that still carry `isTeamDocument` on disk.
      Add a unit test with a fixture v1 document.

### E.2 — Renderer refactor (the big one)

> This is the only "big + risky" remaining piece. Everything else is
> mechanical or self-contained. **Settle decisions before starting**
> (they're all settled — see top of this file).

- [x] **Split sync from CRUD in `UnifiedSyncProvider`**:
  - WS handles `SYNC`, `AWARENESS`, `DOC_EVENT` broadcasts, and the
    initial token validation (`AUTH`) only.
  - All document CRUD goes through `RelayClient` (already built in
    `src/api/relayClient.ts`).
- [x] **Rework `useRelayDocumentStore.setProvider`** — accepts a
      transport-agnostic `DocumentProvider`; `collaborationStore`
      hands it a `RestDocumentProvider` wrapping `RelayClient`.
- [x] **Persist relay URL + JWT** in localStorage under
      `diagrammer-relay-connection` (`src/api/relayConnection.ts`).
      Restored on boot, but per decision #2 not auto-asserted — URL
      only is silently re-applied.
- [x] **On 401 from any REST call** (decision #2): drop the JWT,
      surface a "Session expired — please log in again" toast. No
      silent retry. Wired via `RelayClient.onUnauthorized`.
- [x] **Update `useRelayDocumentStore` action implementations** —
      `fetchDocumentList`, `loadRelayDocument`, `saveToHost`,
      `deleteFromHost`, `updateDocumentShares`,
      `transferDocumentOwnership` — to call the REST client instead
      of WS-multiplexed methods.
- [x] **Drop the WS-multiplex CRUD methods entirely from
      `UnifiedSyncProvider`** — done in commit 3 (140dee1) along with
      `loginWithCredentials` rewrite to call `RelayClient.login()`
      then `sendAuth(token)` over WS for the SYNC channel.

### E.5 — Settings UI rework

- [x] **Delete the "Protected Local" / Collaboration tab** from `SettingsModal.tsx`.
- [x] **Delete `CollaborationSettings.tsx` host/client mode toggle.**
      `useRelayStore` was deleted entirely; callsites now read
      `useConnectionStore.status` via the new `useIsRelayAuthenticated`
      helper.
- [x] **Delete `ClientConnectionPanel.tsx`** + the `RelayMembersManager.tsx`
      member list.
- [x] **Add a "Relay" tab** to `SettingsModal.tsx`: URL pre-filled
      from `relayConnection.loadConnection()` (fallback
      `http://localhost:9876`); Connect/Disconnect; username+password
      form when disconnected; current user + role + URL when
      authenticated; live status indicator.
- [x] **Drop the sidebar "be a host" badge** — now a status indicator
      that opens the Relay tab on click.
- [x] **`AuthGuard` deleted**; renderer is always usable.
- [x] **`DocumentPermissionsDialog`** rewired to free-text user input
      (relay validates IDs server-side).

### E.4 — Delete dead Tauri-side modules

- [x] **`rm -r src-tauri/src/{server,mcp,auth}/`** — done.
- [x] **Strip `src-tauri/src/lib.rs`** — rewritten from 897→160 LOC.
      Only `open_docs` (+ supporting `start_docs_server` /
      `rewrite_clean_urls` helpers) survives. All `mod server/mcp/auth`,
      `AppState`, and every Tauri command except `open_docs` removed.
- [x] **Strip `src-tauri/Cargo.toml`** — dropped `futures-util`,
      `tokio-stream`, `jsonwebtoken`, `bcrypt`, `nanoid`,
      `local-ip-address`, `sha2`, `hex`, `tempfile`, and dev-dep
      `tower`. Kept `axum` + `tower-http` (now `features = ["fs"]`
      only) for the bundled-docs HTTP server.
- [x] **Renderer cleanup of dead command stubs** in
      `src/tauri/commands.ts` — trimmed 273→33 LOC; only `isTauri`
      and `openDocs` remain.
- [x] **Delete `LocalDocumentMirror` references** — `mcpMirror*`
      calls + import dropped from `persistenceStore.ts`; App.tsx
      boot-time bulk-mirror block deleted.
- [x] **Cross-language protocol drift watch** — the src-tauri-side
      `protocol.rs` fixture test is gone; relay-side
      `cargo test --manifest-path relay/Cargo.toml` is now the sole
      Rust-side protocol guard (already passing).
- [x] **MCP Settings tab + userStore** — `McpSettings.{tsx,css}`
      deleted; `useUserStore` rewritten as a 60-line facade over
      `useConnectionStore.user`.

### E.3 — Slim the WS protocol on the relay

- [x] **Remove WS handlers** from `relay/src/server/mod.rs` for
      `DOC_LIST`, `DOC_GET`, `DOC_SAVE`, `DOC_DELETE`, `DOC_SHARE`,
      `DOC_TRANSFER` — deleted alongside the dispatch arms.
- [x] **`AUTH_LOGIN`** removed too (renderer logs in via REST).
      `handle_auth_login` deleted.
- [x] **Kept**: `SYNC`, `AWARENESS`, `DOC_EVENT`, `JOIN_DOC`, `AUTH`,
      `AUTH_RESPONSE`, `ERROR`. Reserved-byte note in protocol module
      docstrings on both sides.
- [x] **Deleted fixtures**: 02, 04–11, 14–17 (13 files).
- [x] **Trimmed TS protocol module**: dropped dead constants,
      interfaces (`DocList*`/`DocGet*`/`DocSave*`/`DocDelete*`/
      `DocShare*`/`DocTransfer*`/`AuthLoginRequest`/`ShareEntry`),
      and helpers (`getMessageChannel`, `isAuthMessage`,
      `isDocumentMessage`, `isRequestMessage`, `MessageChannel`).
      `getMessageTypeName` trimmed to live types.
- [x] **Fixture round-trip tests pass on both sides** — TS
      `protocol.fixtures.test.ts` (12 tests) + Rust
      `server::protocol::fixture_tests` (2 tests). 6 smoke tests
      still pass.

### F — First-launch team-doc migration

- [ ] **Tauri boot scan** of `<app-data-dir>/team_documents/`. For
      each file: parse, write as a local document into the renderer's
      local store via the existing local-save path, then move the
      source into `<app-data-dir>/_archived_team_documents/`
      (idempotent + reversible — never delete).
- [ ] **One-time toast notification** the first time the migration
      runs: *"N team documents were converted to local documents. To
      collaborate on them again, upload them to a relay from Settings
      → Documents."* Persist a flag in localStorage so the toast
      only fires once.
- [ ] **Test fixture set** of beta-era team documents in
      `src-tauri/tests/migration/`. Verify blob hashes line up across
      the move (no orphaned blobs).

### H — Load-bearing invariant tests

- [ ] **`src/store/documentStore.imports.test.ts`**: static assertion
      that `documentStore.ts` does not import from `relayStore`,
      `relayDocumentStore`, `UnifiedSyncProvider`, or
      `src/api/relayClient.ts`. Catches regressions to
      origin-blindness.
- [ ] **"Local docs never touch the relay" integration test**: spin
      up a fake-relay HTTP recorder (e.g. `msw`/`nock`-style in
      jsdom), exercise local-only workflows (create local doc, edit,
      save), assert zero requests reach the recorder.
- [ ] **Protocol fixture round-trip** is already in place from Slice
      A — no work needed here, just confirm it still passes after the
      Slice E.3 pruning.

---

## Out of scope for v2 (do not start)

These are explicit non-goals per the plan; don't let scope creep
pull them in:

- Postgres / S3 / any non-filesystem storage backend
- TLS termination on the relay (run behind nginx / Caddy / Traefik)
- SSO / SAML / SCIM
- Horizontal scaling / sharding / replication
- Audit log dispatcher / webhooks
- `Storage` trait abstraction without a second backend (deferred —
  premature without a real second impl)
- Argon2 password hashing (decision #4)
- Custom relay URL UX beyond the pre-filled localhost (decision #1)
- Credential persistence / silent re-login (decision #2)
- A "be a host" UX in the desktop (decision #7)

---

## Rough effort estimate

| Item | Commits | Risk |
|------|---------|------|
| `User.org_id` | 1 | none |
| Protocol v2 rename (`isRelayDocument`) | 1 | low — fixtures protect |
| E.2 renderer refactor | 1–3 | **medium** — heavy refactor; main risk for the slice |
| E.5 settings UI | 1 | low |
| E.4 delete src-tauri modules | 1 | low (mechanical) |
| E.3 slim WS protocol | 1 | low |
| F migration | 1 | low (test fixtures take real work) |
| H invariant tests | 1 | none |

**Total: ~8–10 commits** depending on how the renderer refactor
splits. E.2 is the only piece that should not be rushed.

---

## Suggested order

1. Pre-flight: `User.org_id` + protocol v2 rename. Establishes the
   wire format the rest of v2 expects.
2. **E.2 first** (not the deletes). With the renderer migrated, every
   subsequent delete is safe. If you delete the Tauri-side modules
   first (E.4), the renderer still calls them at runtime and you'll
   bisect the wrong commit when things break.
3. E.5 (settings UI). Same session as E.2 if you have the energy —
   the UI swap directly exercises the new code paths.
4. E.4 (delete Tauri-side modules).
5. E.3 (slim WS).
6. F (migration). Independent of everything; can happen earlier if
   convenient.
7. H (invariant tests). Last — they ratchet the now-correct state.

---

## Verification gate before declaring v2 functional

A v2 build is "functional minus debugging" when:

- `bun run typecheck` clean.
- `bun run test --run` green.
- `cargo test --manifest-path relay/Cargo.toml` green.
- `cargo check --manifest-path src-tauri/Cargo.toml` green (and the
  src-tauri tree is meaningfully smaller — no more `server/`, `mcp/`,
  `auth/` directories).
- Manual end-to-end: start the relay (`cd relay && cargo run -- init
  && cargo run -- serve`); launch the desktop (`bun run tauri:dev`);
  log in via the Settings → Relay tab; create a doc; edit a shape;
  close + reopen the desktop; confirm the doc still loads and the
  shape persists.
- A second client (second `bun run dev` browser tab) connects to the
  same relay, sees the same doc, and CRDT-syncs an edit in real time.

When that runs end-to-end on a fresh machine, v2 is shippable as
2.0.0-beta.1. Everything below the line in `Todo.md` (Phase 20.4,
20.9) becomes the next phase's problem.
