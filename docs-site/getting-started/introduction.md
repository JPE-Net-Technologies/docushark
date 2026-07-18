---
title: Introduction
description: DocuShark is an offline-first document hub — rich writing, an infinite diagram canvas, and embedded files together in one fast document.
---

# Introduction

Welcome to **DocuShark** — a document hub where your **writing, diagrams, and files live together** in one place. It's offline-first, and it stays fast even when a document grows large and complex.

Most tools make you choose: a doc editor *or* a diagram editor. DocuShark is both at once. A single document holds rich prose, an infinite diagramming canvas, embedded files, and citations — side by side, always in sync. Write the explanation and draw its diagram right beside it, with no app-switching and no screenshots that go stale.

## What DocuShark Is

- **Write** — a full rich-text editor (headings, tables, LaTeX math, code, callouts, citations) for real documentation, not just labels.
- **Diagram** — an infinite canvas with smart connectors and shape libraries (flowchart, UML, ERD, cloud) that stays smooth at thousands of shapes.
- **Store** — drop PDFs, spreadsheets, images, and datasets straight onto the canvas, pinned wherever you want them.
- **Collaborate** — connect a document to a workspace and edit live, with conflict-free syncing so you never lose work.
- **Automate** — connect any MCP-compatible AI agent to draft prose, diagrams, and references directly in your live document.

Whether you're sketching a quick flowchart, writing a design doc with an architecture diagram beside it, or documenting a database schema, DocuShark is built to stay out of your way and let you focus on your ideas.

## What Makes DocuShark Different?

### One Document, No Tool-Switching

Prose and an endless drawing canvas share the same document. A how-to and its diagram, a spec and its data model, notes and the sketch that explains them — together, not scattered across three apps. The workspace even reshapes itself around the task with [layout modes](/guide/layout-modes): a calm reading column for writing, a full cockpit for diagramming, or a split of both.

### It's Fast — Really Fast

Many browser-based tools start to struggle as a diagram grows. DocuShark uses Canvas 2D rendering with spatial indexing (R-tree) to **stay smooth as your work gets large**:

- Smooth pan and zoom no matter how complex your diagram gets
- Instant shape selection and manipulation
- No lag, no waiting, no frustration

### Web & Desktop

DocuShark runs right in your browser — open it, install it as a PWA, and you always have the latest version. It also builds as a **native desktop application** (Windows, Linux, macOS) using Tauri, with native file-system access and fully offline, local-only documents. You get the same editor and the same features either way.

### Real-time Collaboration

Work together in real time: connect a document to a workspace and everyone sees each other's changes live, with automatic conflict-free syncing — you'll never lose work to a conflict. Workspaces also give you cloud storage, sync across your devices, and integrations as they arrive. See [Collaboration](/guide/collaboration) to get started.

### Rich Shape Libraries

Create any kind of diagram with built-in libraries:

- **Basic shapes** — Rectangle, Ellipse, Line, Text, Connector, Group
- **Flowchart** — Process, Decision, Terminator, Data, and more
- **UML** — Class diagrams, Sequence diagrams, Activity diagrams, Use Cases
- **ERD** — Entity-Relationship with Crow's Foot notation
- **Cloud icons** — AWS, Azure, GCP service icons for architecture diagrams

Plus, you can create and share your own **custom shape libraries**.

## What You Can Do

| Feature | What It Means |
|---------|---------------|
| Rich text editor | Write formatted documentation right alongside your diagrams |
| Multi-page documents | Organize complex projects across separate prose and canvas pages |
| Embedded files | Drag-and-drop PDFs, spreadsheets, and images onto the canvas |
| Collections | Group related documents into named, colour-coded sets |
| Smart connectors | Connectors auto-route and follow shapes when you move them |
| Auto-layout | Tidy up connected shapes with one command |
| Citations | Cite sources inline, paste a DOI, generate a bibliography |
| Document fields | Reusable <code v-pre>{{values}}</code> that update everywhere at once |
| Layout modes | Reshape the workspace for writing, diagramming, or both |
| Appearance | Themes, style profiles, and window chrome you can make your own |
| Import | Bring in Excalidraw, draw.io, and Mermaid diagrams |
| AI agents (MCP) | Let an AI assistant draft documents and diagrams for you |
| Whiteboard | Quick sticky-note brainstorming with Ctrl+I |
| Version history | Automatic restore points you can preview and roll back to |
| Full undo/redo | Snapshot-based history — never worry about mistakes |
| Export anywhere | PNG, SVG, PDF, JSON, and .docushark archives |
| Offline-first | Works without internet, syncs when you reconnect |

## What's Next?

This documentation is organized to help you get productive quickly:

1. **[Installation](./installation)** — Run DocuShark in your browser, or build it
2. **[Quick Start](./quick-start)** — Create your first document in under five minutes
3. **[Interface Tour](./interface-tour)** — Learn what every part of the screen does

New to how it all fits together? Read **[How DocuShark Is Organized](/guide/concepts)** for the mental model — documents, pages, prose, canvas, and workspaces. After that, explore the **[Guides](/guide/canvas-navigation)** to go deeper into any feature.
