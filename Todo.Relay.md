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

- [ ] **Delete the "Protected Local" tab** from `SettingsModal.tsx`.
- [ ] **Delete `CollaborationSettings.tsx` host/client mode toggle**
      and the underlying `useRelayStore.startHosting` /
      `connectToHost` calls; those become dead code post-E.4. The
      `useRelayStore` module either shrinks dramatically or goes away.
- [ ] **Delete `ClientConnectionPanel.tsx`** (LAN-discovery scanner).
- [ ] **Add a "Relay" tab** to `SettingsModal.tsx`:
  - Relay URL input, pre-filled with `http://localhost:9876` (decision #1).
  - Connect / Disconnect button.
  - When disconnected: username + password login form.
  - When connected: show current user display name + role + Logout.
  - Connection status indicator (online/offline/authenticated).
- [ ] **Drop LAN-discovery code** wherever it still lives.
      `local_ip_address` Tauri dependency goes away in E.4.

### E.4 — Delete dead Tauri-side modules

> Run **after** E.2 so the renderer no longer depends on any of the
> deleted Tauri commands.

- [ ] **`rm -r src-tauri/src/{server,mcp,auth}/`**.
- [ ] **Strip `src-tauri/src/lib.rs`**:
  - Remove `mod server;`, `mod mcp;`, `mod auth;`.
  - Remove `AppState` fields: `server`, `user_store`, `token_config`,
    `mcp_server`, `server_mode`.
  - Remove Tauri commands and their `tauri::generate_handler!`
    entries: `start_server`, `stop_server`, `get_server_status`,
    `list_team_documents`, `save_team_document`,
    `get_team_document`, `delete_team_document`, plus every MCP
    command (`mcp_get_status`, `mcp_get_token`, etc.) and the
    `mcp_mirror_local_document` / `mcp_unmirror_local_document`
    bridge.
  - Remove the `on_doc_changed` closure block + `McpServer::new`
    setup block.
- [ ] **Strip `src-tauri/Cargo.toml`** deps that only the deleted
      code used: `axum`, `tower-http`, `futures-util`, `tokio-stream`,
      `jsonwebtoken`, `bcrypt`, `nanoid`, `local-ip-address`, `sha2`,
      `hex`. Keep `tokio` (Tauri still wants it). Double-check by
      `cargo check --manifest-path src-tauri/Cargo.toml` after each
      removal.
- [ ] **Renderer cleanup of dead command stubs** in
      `src/tauri/commands.ts`: remove `startServer`, `stopServer`,
      `getServerStatus`, `listTeamDocuments`, the four team-doc
      commands, every MCP wrapper, and `mcpMirrorLocalDocument` /
      `mcpUnmirrorLocalDocument`. Grep `src/` for any remaining
      callers and excise them.
- [ ] **Delete `LocalDocumentMirror` references** in
      `src/store/persistenceStore.ts` (the `mcpMirrorLocalDocument`
      / `mcpUnmirrorLocalDocument` calls).
- [ ] **Cross-language protocol drift watch**: the src-tauri-side
      `protocol.rs` fixture test goes away with this delete. The
      relay-side one stays as the authoritative source. Confirm
      `cargo test --manifest-path relay/Cargo.toml` is the only
      Rust-side protocol guard after the dust settles.

### E.3 — Slim the WS protocol on the relay

> Run **after** E.2 so the renderer has stopped using the WS-CRUD
> multiplex.

- [ ] **Remove WS handlers** from `relay/src/server/mod.rs` for
      `DOC_LIST`, `DOC_GET`, `DOC_SAVE`, `DOC_DELETE`, `DOC_SHARE`,
      `DOC_TRANSFER`.
- [ ] **Decide whether `AUTH_LOGIN` (username/password over WS)
      survives**. Renderer now logs in over REST; this message is
      dead weight. Recommend removing.
- [ ] **Keep**: `SYNC`, `AWARENESS`, `DOC_EVENT` (broadcast),
      `JOIN_DOC`, `AUTH` (bearer-token validation on the WS upgrade).
- [ ] **Delete the corresponding fixtures**
      (`04_doc_list_request.json`, `05_doc_list_response.json`,
      `06_doc_get_request.json`, `07_doc_get_response.json`,
      `08_doc_save_request.json`, `09_doc_save_response.json`,
      `10_doc_delete_request.json`, `11_doc_delete_response.json`,
      `14_doc_share_request.json`, `15_doc_share_response.json`,
      `16_doc_transfer_request.json`, `17_doc_transfer_response.json`,
      and `02_auth_login_request.json` if `AUTH_LOGIN` goes too).
- [ ] **Trim the TS protocol module**: drop the now-unused
      `MESSAGE_DOC_LIST` etc. constants and types. Decide whether
      to keep them as deprecated re-exports (clutter) or just delete
      (cleaner — v2 is a major bump). Recommend delete.
- [ ] **Run fixture round-trip tests on both sides** to confirm the
      pruning was symmetric.

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
