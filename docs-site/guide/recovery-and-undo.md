---
title: Recovery Points & Undo
description: How DocuShark protects your work — automatic recovery points for cloud documents, and undo/redo during a live collaboration session.
---

# Recovery Points & Undo

DocuShark has two separate safety nets, and it's worth knowing what each one actually covers — neither is a full, browse-any-past-version history yet.

## Undo during collaboration

Normal undo/redo (Ctrl/Cmd+Z) works everywhere, including live collaboration — but in a collab session it only undoes **your own recent edits**, not the whole document's history. This is deliberate: once other people are editing alongside you, "undo" can only mean "undo what I just did," not "rewind the shared document," since rewinding would also erase everyone else's work.

- Undo/redo stacks are **per document page** and **session-scoped** — they reset when you reload
- Each distinct action (not every mouse movement) becomes its own undo step
- This does not go back indefinitely — it covers your recent working session, not the document's full lifetime

## Recovery points for cloud documents

Separately, DocuShark automatically captures **recovery points** for documents stored in a workspace — snapshots taken when a document is at risk of losing content (not on a fixed schedule, and not something you trigger manually today).

To see them, open a cloud document's **Backups** panel:

1. Open the document
2. Find the **Backups** option (from the document menu or Documents Home)
3. Browse the list of recovery points, newest first, each showing when it was captured and its size

Each recovery point offers two actions:

- **Restore** — brings the document back to that point in time, as a **new document**. Anyone currently viewing the original is returned to the browser, and their working copy is moved to Trash rather than lost outright. This is a meaningful action, so DocuShark asks you to confirm first.
- **Save to local** — downloads that point's content as a new local (non-cloud) document, without touching the original at all. Use this when you just want a copy, not a rollback.

## What this doesn't do yet

There's no browsable, complete version history — you can't scrub through every edit ever made to a document, and recovery points are captured automatically rather than on demand ("save a version now"). If you need a guaranteed checkpoint before a risky edit, **Save to local** is the closest thing to a manual save point today.

## See also

- [Collections](./collections) — organizing documents, including where Trash fits in
- [Collaboration](./collaboration) — how live editing works alongside undo
