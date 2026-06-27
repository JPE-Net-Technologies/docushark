---
title: Introduction
description: DocuShark is a fast, offline-first diagramming and whiteboard app that stays smooth on large, complex diagrams.
---

# Introduction

Welcome to **DocuShark** — a fast, offline-first diagramming and whiteboard app that keeps things smooth even on large, complex diagrams.

Whether you're sketching a quick flowchart, building a complex enterprise architecture diagram, or documenting a database schema, DocuShark is designed to stay out of your way and let you focus on your ideas.

## What Makes DocuShark Different?

### It's Fast — Really Fast

Many browser-based diagram tools start to struggle as a diagram grows. DocuShark uses Canvas 2D rendering with spatial indexing (R-tree) to **stay smooth as your diagrams get large**. That means:

- Smooth pan and zoom no matter how complex your diagram gets
- Instant shape selection and manipulation
- No lag, no waiting, no frustration

### Desktop & Web

DocuShark runs as a **native desktop application** (Windows, Linux, macOS) using Tauri, giving you native file system access and system-level performance. It also works right in your browser for quick access without installation.

### Real-time Collaboration

Work together in real time: connect a document to a relay and everyone sees each other's changes live. Sync uses CRDTs, so edits merge automatically and you'll never lose work to a conflict. See [Collaboration](/guide/collaboration) to get started.

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
| Multi-page documents | Organize complex projects across separate pages |
| Collections | Group related documents into named, colour-coded sets |
| Smart connectors | Connectors auto-route and follow shapes when you move them |
| Auto-layout | Tidy up connected shapes with one command |
| Rich text editor | Write formatted documentation right alongside your diagrams |
| Citations | Cite sources inline, paste a DOI, generate a bibliography |
| Document fields | Reusable <code v-pre>{{values}}</code> that update everywhere at once |
| Layout modes | Switch the workspace between writing, diagramming, or both |
| Import | Bring in Excalidraw, draw.io, and Mermaid diagrams |
| AI agents (MCP) | Let an AI assistant draft documents and diagrams for you |
| Embedded files | Drag-and-drop PDFs, spreadsheets, and images onto the canvas |
| Whiteboard | Quick sticky-note brainstorming with Ctrl+I |
| Full undo/redo | Snapshot-based history — never worry about mistakes |
| Export anywhere | PNG, SVG, PDF, JSON, and .docushark archives |
| Themes | Dark and light themes with customizable style profiles |
| Offline-first | Works without internet, syncs when you reconnect |

## What's Next?

This documentation is organized to help you get productive quickly:

1. **[Installation](./installation)** — Download or build DocuShark
2. **[Quick Start](./quick-start)** — Create your first diagram in under five minutes
3. **[Interface Tour](./interface-tour)** — Learn what every part of the screen does

After that, explore the **[Guides](/guide/canvas-navigation)** to go deeper into any feature.
