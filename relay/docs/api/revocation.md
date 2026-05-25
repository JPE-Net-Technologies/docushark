# Token Revocation

The relay supports two revocation transports:

1. **Push (preferred).** The operator's control plane POSTs to the relay's `/api/v1/internal/revoke` endpoint when a token is revoked. Propagation is typically sub-second.
2. **Polling fallback.** The relay periodically polls a configured `revocation_polling_url` for revocations since the last poll. Covers cases where the push transport fails.

Both transports may be enabled at once. The relay deduplicates revocations by `jti`.

## Why a window

Revocation cannot be instantaneous in a distributed system. The relay accepts a propagation window between "control plane marks token revoked" and "every relay rejects requests bearing it." For the push transport, the happy-path window is the round-trip + retry budget — about 1 second under normal conditions. For the polling fallback, the window is the polling interval (default 60s).

A 60s window is well within industry norms for token revocation (Stripe API keys, GitHub PATs are minute-scale). The threat model worth worrying about — an active attacker acting on a stolen token *immediately* — is better defended by:

- Anomaly detection at the issuer (new IP, new device → step-up).
- Short token lifetimes (limit damage even if revocation fails).
- DPoP token-binding (out of scope for v1).

Operators with stricter requirements should shorten the polling interval.

## Push transport

### Endpoint

`POST /api/v1/internal/revoke`

### Authentication

`Authorization: Bearer <revocation_push_bearer>` — the shared secret configured in `relay.toml` `[webhooks]`. Constant-time comparison.

### Request body

```json
{
  "revocations": [
    { "jti": "tok_01H...", "revoked_at": "2026-05-21T15:00:00Z" },
    { "jti": "tok_02H...", "revoked_at": "2026-05-21T15:00:01Z" }
  ]
}
```

The relay applies each revocation to its in-memory revocation set. Returns `204 No Content` on success.

### Failure behaviour

- `401` — bad bearer. The control plane should rotate and retry.
- `5xx` — relay-side problem. The control plane should retry with backoff. The polling fallback covers persistent failures.

### Outbound confirmation

After successful application, the relay emits a `revocation.applied` webhook (see `webhooks.md`) so the control plane can confirm propagation per-relay.

## Polling fallback

### Configuration

```toml
[auth]
revocation_polling_url = "https://control-plane.example.com/api/v1/revocations"
revocation_polling_bearer = "<shared secret>"
revocation_polling_interval_seconds = 60
```

### Protocol

Every `revocation_polling_interval_seconds`, the relay GETs:

```
GET https://control-plane.example.com/api/v1/revocations?since=<iso-8601>
```

Expected response:

```json
{
  "revocations": [
    { "jti": "tok_01H...", "revoked_at": "2026-05-21T15:00:00Z" },
    { "jti": "tok_02H...", "revoked_at": "2026-05-21T15:00:01Z" }
  ],
  "next_since": "2026-05-21T15:00:01Z"
}
```

The relay applies each revocation and advances `since` to `next_since`. On error, `since` is not advanced; the relay retries on the next interval.

The control plane is expected to serve revocations in stable timestamp order and to honour `since` as an exclusive lower bound.

## Revocation set semantics

- **JTI-keyed.** Revocations identify tokens by `jti` claim, not by `sub`. Revoking all of a user's tokens means listing every active JTI.
- **No expiry.** Revocations stay in the set forever (memory-bounded by the token TTL — once `exp` passes, the JTI is naturally moot). Operators with very long-lived tokens may want to GC the set externally and re-push.
- **Bounded memory.** The relay caps the in-memory revocation set at 1M entries. Beyond this it starts evicting the oldest entries — choose token TTLs and revocation patterns accordingly.

## Fail-open vs fail-closed

By default the relay **fails closed** on revocation lookup — if both push and polling transports are unconfigured, every token-bearing request is accepted (no revocations to check against). To require revocation infrastructure, configure at least one transport.

If you configure both transports and both fail simultaneously, the relay continues serving with the last-known revocation set. This is intentional — a control-plane outage should not knock all relays offline. If your threat model requires fail-closed-on-staleness, monitor the `revocation_set_age_seconds` metric and decommission stale relays externally.
