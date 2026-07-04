---
title: Offline & Sync
description: What "offline" means for each kind of DocuShark document, how to make a cloud document available offline on purpose, and reading the sync status badge.
---

# Offline & Sync

DocuShark is offline-first, but what "offline" means depends on where a document lives.

## Three kinds of documents

- **Local** — lives only on this device. Always available offline, since it was never anywhere else to begin with.
- **Cloud (remote)** — lives in a workspace. Available offline only for what's already been downloaded to this device — anything you haven't opened or viewed yet may not be cached locally.
- **Cached** — a cloud document DocuShark has already pulled a local copy of, so it opens instantly and works offline even before you reconnect.

## Reading the sync badge

Every document shows a small status badge:

| Badge | Meaning |
|-------|---------|
| **Synced** | Up to date with your workspace |
| **Syncing** | Changes are actively going up or down right now |
| **Pending** | You have local changes waiting to sync (e.g. you're offline right now) |
| **Error** | The last sync attempt failed |
| **Local** | A personal document — nothing to sync, by design |
| **Idle** | Signed in, document just isn't open right now — it'll sync instantly when you reopen it |
| **Offline** | Cached and usable, but not currently reachable — changes will sync once you're back online |

## Making a document available offline

Blobs (images, embedded files) inside a cloud document are normally fetched on demand — only what you've actually viewed gets cached locally. If you know you're about to lose your connection (a flight, a site visit, spotty wifi), tell DocuShark to grab everything up front instead:

1. Find the document in Documents Home
2. Choose **Make available offline**
3. DocuShark downloads the document body and every file/image it references, showing progress as it goes

Once complete, the document is fully usable offline — including editing, not just viewing — because DocuShark also seeds the local collaborative session data it needs to let you keep working and sync up later.

A document can end up **partially** available if some blobs fail to download (a flaky connection, for instance) — it's still usable, just not guaranteed complete until you retry.

## See also

- [Collaboration](./collaboration) — how documents get into a workspace in the first place
- [Version History & Undo](./recovery-and-undo) — DocuShark's safety nets for cloud documents
