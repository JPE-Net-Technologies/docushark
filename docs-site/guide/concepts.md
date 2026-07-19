---
title: How DocuShark Is Organized
description: The mental model behind DocuShark — documents, pages, prose and canvas, files, collections, and local vs workspace storage.
---

# How DocuShark Is Organized

DocuShark has a small set of building blocks. Once these click, everything else
in the app — and in these guides — falls into place. This page is the map; each
section links to the guide that goes deep.

## The one-minute model

- A **document** is the thing you open and work in. It has a name and lives in
  your **library**.
- Every document is made of **pages**. A page is either a **prose page**
  (writing) or a **canvas page** (an infinite diagram surface).
- **Prose and canvas are two views of the same document**, not two different
  apps. A **layout mode** decides how much of each you see.
- Documents are grouped into **collections** (like folders) and described with
  **tags** (like labels).
- A document is either **local** (on your device) or lives in a **workspace**
  (synced and shareable).

That's the whole model. The rest of this page unpacks each piece.

## Documents and your library

A **document** is your unit of work — a design doc, an architecture diagram, a
research note, a runbook. When you open DocuShark you land on the **Documents**
home: your library of every document, with recent ones surfaced as preview
cards. Create a new one with the **New** button; click **Documents** in the
top-left to return to the library any time.

A single document can hold a *lot*: multiple pages of writing and diagrams,
embedded files, citations, and reusable fields. You rarely need "a folder of
files" — you need one document that holds the whole idea.

## Pages: prose and canvas

Inside a document, content is split across **pages**, shown as tabs. There are
two kinds:

| Page type | What it's for | Powered by |
|-----------|---------------|------------|
| **Prose page** | Rich writing — headings, lists, tables, math, code, callouts, citations | A full text editor |
| **Canvas page** | Diagrams — shapes, smart connectors, embedded files | An infinite canvas |

Each page is independent: shapes on one canvas page don't appear on another, and
each prose page has its own text. Add, rename, reorder, and colour-code pages
from the tab bar — see [Multi-Page Documents](/guide/multi-page-documents).

::: tip
Think of pages as the *sections* of one deliverable — "Overview", "Data Model",
"API Flow" — rather than separate files. Order them from overview to detail.
:::

## Prose + canvas, side by side

The heart of DocuShark: **writing and diagramming live in the same document.**
You don't paste a screenshot of a diagram into your doc — the diagram *is* in the
doc, on its own canvas, always current.

How much of each you see is set by the **layout mode** (Relaxed, Designer,
Technician, Power) and, in Relaxed, the **Write · Split · Diagram** focus. Writing
a spec? Stay in Write. Explaining a diagram? Split them side by side. Deep in a
diagram? Switch to Diagram. Nothing moves in the document — only your view of it.
See [Layout Modes](/guide/layout-modes).

## Files that live with the document

Beyond prose and shapes, you can drop **files** — PDFs, spreadsheets, images,
datasets — straight onto a canvas, pinned wherever you want them. They travel
with the document and export with it. See [Embedded Files](/guide/embedded-files).

## Organizing many documents: collections and tags

As your library grows, two tools keep it navigable, and they answer different
questions:

- **Collections** answer *"where does this document live?"* — each document sits
  in at most one collection, like a folder.
- **Tags** answer *"what is this document about?"* — a document can carry many
  tags, and search can target them with `#`.

See [Collections & Tags](/guide/collections) for the full workflow.

## Local vs. workspace documents

This is the one distinction worth learning early, because it decides where a
document lives and who can reach it:

| | **Local document** | **Workspace document** |
|---|---|---|
| Lives | On your device | In a workspace (synced) |
| Works offline | Always | Cached for offline, syncs on reconnect |
| Sharing / live collaboration | No — it's yours alone | Yes — invite others to edit live |
| Best for | Private notes, offline work | Team docs, cross-device sync |

A **workspace** is a shared space you connect a document to; it adds cloud
storage, sync across your devices, real-time collaboration, and integrations. You
can promote a local document into a workspace when you're ready to share it. See
[Collaboration](/guide/collaboration) and
[Sharing & Workspace Access](/guide/sharing-and-access).

::: info Terminology
Throughout these guides, **"workspace"** means the shared, synced space your
documents connect to. You'll never need to think about the server behind it.
:::

## Where to go next

- **[Interface Tour](/getting-started/interface-tour)** — see these pieces on the
  actual screen.
- **[Quick Start](/getting-started/quick-start)** — build your first document.
- **[Tutorials](/tutorials/design-doc-with-diagram)** — end-to-end walkthroughs
  that put the whole model to work.
