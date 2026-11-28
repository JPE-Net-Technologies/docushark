---
title: Organize
description: Pages inside a document, collections and tags across your library, undo, version history and the Trash, and working offline.
---

# Organize

There are two levels to keep in order: the pages inside a document, and the documents in your library. This page covers both, then the safety nets that let you undo, go back to an earlier version or recover a deleted document, and how documents work offline.

## Pages {#pages}

A document holds two kinds of pages: **writing pages** and **diagrams**. Each kind has its own row of tabs: the writing tabs sit above your writing, and the diagram tabs sit in the canvas's tool row. A new document starts with one of each, and each page's content is its own.

- **A page's name** comes from its first heading, the way a browser tab takes its title from the page, until you rename it. A page with no heading is "Page 2" or "Diagram 2".
- **Add a page** with **+ Page** or **+ Diagram** at the end of its row.
- **A page's menu** has **Rename**, **Color** (writing pages), **Duplicate** (diagrams) and **Delete page**. Open it with the **⋯** on the tab, by right-clicking the tab, by pressing and holding it on a touch screen, or with `Shift+F10` on a focused tab. `F2` or a double-click on the tab also renames.
- **Delete page** removes the page straight away. For ten seconds, **Undo** in the message that appears brings it back. A document always keeps at least one page of each kind.
- **Rest the pointer** on a tab to see the page's full name, its length, and where it falls in the PDF.
- **Reorder** writing pages by dragging their tabs; reorder diagrams, or any page, in the Navigator.

Treat pages as the sections of one piece of work, ordered from overview to detail: "Overview", "Data model", "API flow". A PDF export prints the pages in order; see [Export and import](./export-import).

**The Navigator** panel lists every page, writing pages and diagrams, in the order they export. Click a page to go to it, or drag pages to reorder them. Turn it on from the layout button's **Panels** section, or with **Toggle Navigator panel** in the command palette (`Ctrl+K`).

### Pages from Notion {#mirrored-pages}

A **mirrored page** shows a live, read-only copy of a Notion page inside a workspace document. It needs the Notion integration, connected from your account's **Integrations** page, and only pages you've shared with DocuShark in Notion can be found.

- **Add one** with **Tools → New page from Notion…** (or from the command palette), then search for the page. To start a whole document from a page, use the arrow beside **New** in Documents and choose **From Notion…**.
- **A banner** above the page names the source and when it last synced, with **Refresh**, **Open in Notion** and **Detach**. Detach turns it into an ordinary editable page with the content as last synced; it can't be undone.
- **Subpages:** open the tab's menu (its **⋯**, or a right-click) and choose **Add subpages…** to mirror the source's subpages too, a few levels deep if you like. They share one tab with a menu, and the Navigator shows them under their parent, with how long ago each synced, **Refresh all**, and a button to put pages back in the source's order.

Headings, lists, tables, images and attachments come across; anything the import can't represent is reported when the page is added. Mirrored pages aren't offered in a local document, because they live in your workspace.

## Collections and tags {#collections-and-tags}

Your library answers two questions:

- **Where does this document live?** Its **collection**, like a folder. A document sits in one collection at most; the rest show as **Unassigned**.
- **What is it about?** Its **tags**. A document can carry up to 20, and each tag keeps the same colour everywhere.

**Collections** are listed on the left of **Documents**. Click one to see only its documents, or use the **+** beside the heading to make one. Each has a name and, if you like, a colour, and you choose their order. To see the whole library grouped by collection, choose **View → Group by → Collection**. Deleting a collection never deletes its documents; they return to Unassigned.

To put a document in a collection, open the **⋯** menu on its card and choose **Move to collection**. With several documents selected, the selection bar's **Add to collection** moves them all.

**Tags** are added from a card's **⋯ → Edit tags…** (type a tag and press `Enter`, or pick one you've used before), or with **Add tags** for a whole selection.

**Search** matches names and tags. Start with `#` to search tags only, such as `#research`; clicking a tag on a card does that for you. Press `/` anywhere in the library to jump to the search box.

A collection belongs to a place: this device, or a workspace. So a local document can only join a local collection, a workspace document only a workspace collection, and a document that moves between them, or comes back from the Trash, arrives Unassigned. Tags describe the document itself and always go with it.

## Undo, version history and the Trash {#history-and-trash}

**Undo** (`Ctrl+Z`) and **Redo** (`Ctrl+Shift+Z`) step through your recent changes, one action at a time. Each page keeps its own history, which starts afresh when you reload. In a shared document, undo takes back only your own changes, never someone else's.

**Version history** covers documents in a workspace. DocuShark keeps versions for you: while a document is being edited, when the last person leaves it, and before anything that risks losing content. Open it from **Tools → Version history**, or from **Version history** on the document's card. Opening it saves a version of the document as it is now, so the list starts from the present. Versions are grouped by day; select one to see its pages with their shape and word counts, and how it differs from now. Then:

- **Restore** brings the document back to that point as a new document. Anyone who has the original open keeps their working copy, and everyone else finds theirs in the Trash. DocuShark asks you to confirm first.
- **Save to local** makes a local copy of that version and leaves the original alone. It's also the closest thing to a save point: there's no "save a named version" yet, and local documents have no version history.

**Deleting** from a card's **⋯** menu is quick and recoverable. A local document goes at once, with an **Undo** in the message. A workspace document asks first, because it disappears for everyone; a copy stays in your Trash. **Delete permanently…** skips the Trash and always asks.

The **Trash**, on the left of Documents, restores a document (as a local document, outside any collection) or deletes it for good. Documents left in the Trash are removed after a while.

## Offline {#offline}

DocuShark works offline, but what's available depends on where a document lives:

- A **local** document is always available. It was never anywhere else.
- A **workspace** document is available offline once it's on this device. Opening it keeps a copy here, though files and images you haven't viewed may be missing; making it available offline (below) fetches everything. Changes you make offline sync when you reconnect.

Before a flight or a site visit, click **Make available offline** on the document's card. DocuShark downloads the document and every file and image in it, with a progress bar, so you can keep editing without a connection. If some files fail to download, the document still works, and you can try again later.

Each document shows its state in a badge:

| Badge | Meaning |
|---|---|
| **Synced** | Up to date with your workspace. |
| **Syncing** | Changes are going up or down right now. |
| **Pending** | Changes are waiting to sync, for example while you're offline. |
| **Offline** | Usable here, but your workspace can't be reached; changes sync when it can. |
| **Idle** | Not open right now; it syncs as soon as you open it. |
| **Error** | The last sync failed. |
| **Local** | Kept on this device, so there's nothing to sync. |
