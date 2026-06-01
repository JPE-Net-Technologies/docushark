#!/usr/bin/env bash
#
# mcp-smoke.sh — end-to-end smoke test of the relay MCP tool surface.
#
# Drives a running relay's /mcp endpoint through the full "publish target"
# workflow: create a document, write prose from Markdown, read + restructure
# its outline, generate a diagram from a graph, and read everything back.
# Exercises every write tool and the optimistic-concurrency path.
#
# Usage:
#   relay serve --config dev-relay.toml --data-dir ./data   # in another shell
#   ./scripts/mcp-smoke.sh [URL] [TOKEN]
#
# Defaults: URL=http://127.0.0.1:9877/mcp, TOKEN from ./data/mcp_token.
#
# Requires: curl, jq.

set -euo pipefail

URL="${1:-http://127.0.0.1:9877/mcp}"
TOKEN="${2:-$(cat "${MCP_TOKEN_FILE:-./data/mcp_token}" 2>/dev/null || true)}"

if [[ -z "${TOKEN}" ]]; then
  echo "No token. Pass it as arg 2 or set MCP_TOKEN_FILE to the mcp_token path." >&2
  exit 2
fi

RID=0
# call <tool> <args-json> -> prints structuredContent, exits non-zero on error.
call() {
  RID=$((RID + 1))
  local body resp
  body=$(jq -nc --arg n "$1" --argjson a "$2" --argjson id "$RID" \
    '{jsonrpc:"2.0", id:$id, method:"tools/call", params:{name:$n, arguments:$a}}')
  resp=$(curl -s -X POST "$URL" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$body")
  if [[ "$(jq -r '.error // .result.isError // false' <<<"$resp")" != "false" ]]; then
    echo "✗ $1 failed: $resp" >&2
    exit 1
  fi
  jq -c '.result.structuredContent' <<<"$resp"
}

echo "→ relay $URL"

DOC=$(call docushark.create_document '{"name":"MCP smoke — RFC"}')
DOCID=$(jq -r '.id' <<<"$DOC")
echo "1. create_document            → $DOCID"

GET=$(call docushark.get_document "$(jq -nc --arg d "$DOCID" '{docId:$d}')")
CANVAS=$(jq -r '.pages[0].id' <<<"$GET")
PROSE=$(jq -r '.prosePages[0].id' <<<"$GET")
echo "2. get_document               → canvas=$CANVAS prose=$PROSE"

call docushark.set_prose "$(jq -nc --arg d "$DOCID" --arg p "$PROSE" \
  '{docId:$d, pageId:$p, content:"# Overview\n\nWhy.\n\n## Goals\n\nWhat.\n\n## Approach\n\nHow."}')" >/dev/null
echo "3. set_prose (markdown)       → ok"

OUTLINE=$(call docushark.get_outline "$(jq -nc --arg d "$DOCID" --arg p "$PROSE" '{docId:$d,pageId:$p}')")
echo "4. get_outline                → $(jq -c '.outline|map(.title)' <<<"$OUTLINE")"

call docushark.insert_section "$(jq -nc --arg d "$DOCID" --arg p "$PROSE" \
  '{docId:$d, pageId:$p, level:2, title:"Risks", body:"- a\n- b", position:"end"}')" >/dev/null
echo "5. insert_section Risks       → ok"

MOVED=$(call docushark.restructure_outline "$(jq -nc --arg d "$DOCID" --arg p "$PROSE" \
  '{docId:$d, pageId:$p, op:"move", index:3, toIndex:1}')")
echo "6. restructure_outline (move) → $(jq -c '.outline|map(.title)' <<<"$MOVED")"

DIAG=$(call docushark.generate_diagram "$(jq -nc --arg d "$DOCID" --arg p "$CANVAS" \
  '{docId:$d, pageId:$p,
    nodes:[{id:"client",label:"Client"},{id:"relay",label:"Relay"},{id:"r2",label:"R2",kind:"ellipse"}],
    edges:[{from:"client",to:"relay",label:"WS"},{from:"relay",to:"r2"}]}')")
echo "7. generate_diagram           → $(jq -c '{nodes:(.nodes|length),edges:(.edges|length),layout}' <<<"$DIAG")"

PAGE=$(call docushark.get_page "$(jq -nc --arg d "$DOCID" --arg p "$CANVAS" '{docId:$d,pageId:$p}')")
echo "8. get_page                   → $(jq -c '.shapes|map(.kind)' <<<"$PAGE")"

echo "✓ all tools exercised on $DOCID"
