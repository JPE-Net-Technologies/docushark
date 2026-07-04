---
title: Version History & Undo
description: How DocuShark protects your work — automatic version history for cloud documents, and undo/redo during a live collaboration session.
---

# Version History & Undo

DocuShark has two separate safety nets, and it's worth knowing what each one actually covers.

## Undo during collaboration

Normal undo/redo (Ctrl/Cmd+Z) works everywhere, including live collaboration — but in a collab session it only undoes **your own recent edits**, not the whole document's history. This is deliberate: once other people are editing alongside you, "undo" can only mean "undo what I just did," not "rewind the shared document," since rewinding would also erase everyone else's work.

- Undo/redo stacks are **per document page** and **session-scoped** — they reset when you reload
- Each distinct action (not every mouse movement) becomes its own undo step
- This does not go back indefinitely — it covers your recent working session, not the document's full lifetime

## Version history for cloud documents

Separately, DocuShark keeps an automatic **version history** for documents stored in a workspace. Versions are captured for you — periodically while a document is being edited, when the last person leaves it (if anything changed), and as an extra backup whenever a document is at risk of losing content. A bounded number of recent versions is kept per document, newest first.

To browse them, open **Version history**:

1. Open the document and click the **history icon** in the toolbar — or use the **Version history** action on the document's card in Documents Home
2. Versions are grouped by day, each showing when it was captured and its size
3. Select a version to see a quick summary of what's inside — its pages with shape and word counts, and how that differs from the current document

Each version offers two actions:

- **Restore** — brings the document back to that point in time, as a **new document**. Collaborators who have the original open keep an offline local copy of their working state; everyone else finds their copy in Trash rather than losing it outright. This is a meaningful action, so DocuShark asks you to confirm first.
- **Save to local** — downloads that version's content as a new local (non-cloud) document, without touching the original at all. Use this when you just want a copy, not a rollback.

## What this doesn't do yet

Versions are captured automatically rather than on demand — there's no "save a named version now" yet, and no side-by-side visual diff between versions. If you need a guaranteed checkpoint before a risky edit, **Save to local** is the closest thing to a manual save point today. Local (non-cloud) documents don't have version history; they're covered by undo and Trash.

## See also

- [Collections](./collections) — organizing documents, including where Trash fits in
- [Collaboration](./collaboration) — how live editing works alongside undo
