# Protocol Fixtures

Cross-language golden fixtures for the WebSocket sync protocol.
Loaded by both the TypeScript renderer test suite
(`src/collaboration/protocol.fixtures.test.ts`) and the Rust relay
test suite (`relay/src/server/protocol.rs#fixture_tests`) to
guarantee TS and Rust stay in lockstep.

If you change a message payload shape on either side, you **must**
update or add a fixture here. CI will be red otherwise.

## Scope after Slice E.3

Only WS-resident messages have fixtures here:

| File | messageType | messageName | kind |
|------|-------------|-------------|------|
| 01 | 2 | AUTH | request |
| 03 | 9 | AUTH_RESPONSE | response |
| 12 | 7 | DOC_EVENT | event |
| 13 | 10 | JOIN_DOC | oneshot |
| 18 | 8 | ERROR | response |

The pre-E.3 DOC_LIST / DOC_GET / DOC_SAVE / DOC_DELETE /
DOC_SHARE / DOC_TRANSFER / AUTH_LOGIN fixtures were deleted along
with their WS handlers. Those operations now ride REST
(`relay/src/api.rs`) and aren't part of the byte-prefixed wire
protocol.

`SYNC` (0) and `AWARENESS` (1) carry opaque binary Yjs payloads
rather than JSON; they have no fixtures here.

## Format

Each fixture is a single JSON file:

```json
{
  "messageType": 7,
  "messageName": "DOC_EVENT",
  "kind": "event",
  "payload": { "eventType": "updated", "docId": "...", "userId": "..." }
}
```

- `messageType` — numeric `MESSAGE_*` constant (must match both sides).
- `messageName` — human-readable label (uppercase, no `MESSAGE_` prefix).
- `kind` — `"request"`, `"response"`, `"event"`, or `"oneshot"`.
- `payload` — the JSON payload after the 1-byte type prefix. Keys use
  camelCase to match `serde(rename_all = "camelCase")` on the Rust side
  and the literal field names on the TS side.
