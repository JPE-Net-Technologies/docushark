# Webhooks

The relay emits outbound webhooks for events that an operator's control plane or external integration needs to react to. Webhooks are **operator-configured** in `relay.toml` `[webhooks]` — the relay never calls out without an explicit destination.

## Configuration

```toml
[webhooks]
revocation_push_url = "https://control-plane.example.com/api/relay/revocations"
revocation_push_bearer = "<shared secret, rotated regularly>"

doc_events_url = "https://control-plane.example.com/api/relay/doc-events"
doc_events_bearer = "<shared secret>"
```

If a URL is unset, the relay does not emit that family of webhooks. Each family has its own configuration so operators can subscribe selectively.

## Delivery semantics

- **HTTP POST.** JSON body.
- **At-least-once delivery.** The relay retries on 5xx / network errors with exponential backoff (3 attempts, 1s / 4s / 16s).
- **Best-effort ordering.** Events within a single HTTP request body are ordered; across requests, ordering is not guaranteed under retries.
- **Idempotency key.** Each event carries a `event_id` (UUIDv7); consumers should de-duplicate.
- **Auth.** Bearer secret in the `Authorization` header. Constant-time comparison server-side. Rotated by operators.

## Common envelope

```json
{
  "event_id": "01HXX...",
  "event_type": "revocation.applied",
  "emitted_at": "2026-05-21T15:00:00Z",
  "relay": {
    "region": "yyz",
    "tenancy": "shared"
  },
  "payload": { /* event-specific */ }
}
```

## Event types

### `revocation.applied`

Emitted when the relay successfully applies a revocation push from `revocation_push_url` (the inbound channel — see `revocation.md`). Lets the control plane confirm propagation.

```json
{
  "event_id": "01HXX...",
  "event_type": "revocation.applied",
  "emitted_at": "2026-05-21T15:00:00Z",
  "payload": {
    "jti": "tok_01H...",
    "applied_at": "2026-05-21T15:00:00Z"
  }
}
```

### `doc.updated`

Emitted when a document is created, modified, or deleted. Lets the control plane drive search-indexing, preview-regeneration, usage-metering, audit logs.

```json
{
  "event_id": "01HXX...",
  "event_type": "doc.updated",
  "emitted_at": "2026-05-21T15:00:00Z",
  "payload": {
    "doc_id": "doc_01H...",
    "workspace_id": "ws_01H...",
    "actor": {
      "sub": "user_01H...",
      "kind": "user"
    },
    "change_kind": "created | modified | deleted",
    "version": 42,
    "size_bytes": 12345
  }
}
```

Notes:
- No document content is included. Consumers fetch via `/api/docs/{id}` if they need it. This keeps webhook payloads small and avoids leaking content into log pipelines.
- `actor.kind` distinguishes `user` (interactive) from `mcp` (programmatic). Useful for audit + abuse detection.

### `doc.share_link_used`

Emitted on first access of a share link (per session). Reserved — lights up when the share-link surface ships.

```json
{
  "event_id": "01HXX...",
  "event_type": "doc.share_link_used",
  "emitted_at": "2026-05-21T15:00:00Z",
  "payload": {
    "doc_id": "doc_01H...",
    "share_token": "shr_01H...",
    "client_ip_hash": "sha256:abc...",
    "user_agent_class": "browser | bot | crawler"
  }
}
```

Privacy note: raw IPs are never sent. The relay sends a salted SHA-256 of the IP, with the salt rotated daily. Consumers can detect repeated access from the same IP within a day but cannot reverse-engineer the address.

## What is NOT a webhook event

- **Awareness frames** (cursor/selection state) are not emitted. They're high-frequency and ephemeral; the WebSocket surface is the appropriate channel.
- **Per-message CRDT updates** are not emitted. Only `doc.updated` aggregates.
- **Authentication failures** are not emitted. They're available via the relay's own logs / metrics. Webhooks are for state changes, not security audit trail.

## Adding a new event type

Adding event types is additive within `v1`. Adding new optional fields to existing payloads is additive within `v1`. **Renaming a field, removing a field, or changing the meaning of an existing field is a major-version change** — see `deprecation-policy.md`.
