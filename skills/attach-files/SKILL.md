---
name: docushark-attach-files
description: Use when the user wants to attach, read, or manage files in a DocuShark document over MCP — uploading a report/image/CSV as a canvas file card, downloading an attachment's bytes, or checking storage headroom. Requires the DocuShark MCP server to be connected.
---

# Work with document files in DocuShark

Documents carry files two ways: **canvas file cards** (a FileShape with a name,
type, and size — the general attachment surface) and **prose-embedded images**
(`blob://<hash>` image srcs inside a prose page). Bytes live in the workspace's
content-addressed blob store; every reference is a `blobRef` (the SHA-256 of
the bytes). Work in one **team** document.

## Read files

1. **Discover.** `list_files(docId)` → every attachment with `source`
   (canvas/prose), `pageId`, `blobRef`, `fileName`, `mimeType`, `sizeBytes`,
   and `inStore`. `inStore: false` means the bytes never reached this relay
   (e.g. a desktop-local attachment) — you can see it but not fetch it.
2. **Fetch bytes.** `get_file(docId, blobRef)` → either a short-lived
   `{transport:"url", url}` to GET directly (no auth headers — it's presigned
   and expires; re-call for a fresh one), or `{transport:"inline", base64}`
   for small files on a filesystem-backed relay. Files over the inline cap on
   a filesystem relay are only viewable in the app.

## Attach a file

`add_file(docId, pageId, fileName, <source>, x?, y?, label?)` — `pageId` is a
**canvas** page id (from `get_document`). Provide exactly ONE source:

- `base64` — the file's bytes, standard padded base64. For small files (the
  request body caps around 8 MB total, ~5.5 MB of real bytes). Ideal for
  content you just generated (a CSV, an SVG, a small PDF).
- `url` — an `https` URL the relay fetches server-side (optionally with an
  `authorization` header value you supply). The relay operator must allowlist
  the host (`RELAY_BLOB_INGEST_ALLOWED_HOSTS`); expect
  `ERR_INGEST_NOT_CONFIGURED` when no allowlist is set. Use for anything too
  big for base64.
- `blobRef` — attach a blob already in the workspace store (from `list_files`
  on another document, or a previous upload) without moving bytes.

It returns `{shapeId, blobRef, mimeType, sizeBytes, fileCategory}`. Pass
`mimeType` explicitly when you know it; otherwise the relay infers from the
URL response or the `fileName` extension. `x`/`y` are the card's center in
world units — omit for the origin, or place it near related shapes.

If the attach step fails after an upload, the error carries the stored
`blobRef` — retry with that `blobRef` as the source instead of re-uploading.

## Storage headroom

`get_storage()` → `{usedBytes, quotaBytes, maxBlobBytes}`. `quotaBytes: null`
means unlimited. Check before a large upload; a quota overrun fails the
upload with `ERR_QUOTA_EXCEEDED` and nothing is attached.

## Tips

- The card renders with a category icon (pdf / spreadsheet / image / text /
  generic) plus the file name; users open it in a viewer from the canvas.
  Give `fileName` a real extension — it drives both the icon and the viewer.
- Prose-embedded images: reference an **already-stored** blob as
  `<img src="blob://<hash>">` via `set_prose` with `format:"html"`. Upload
  new bytes with `add_file` first (the card can live on any canvas page),
  then reuse its `blobRef` in the prose image.
- Don't base64 multi-megabyte files into a tool call reflexively — prefer the
  `url` source, or ask the user to drag the file into the app.
