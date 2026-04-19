# Introduction

Welcome to **Diagrammer** — a fast, offline-first diagramming and whiteboard app that keeps things smooth even with thousands of shapes on screen.

Whether you're sketching a quick flowchart, building a complex enterprise architecture diagram, or documenting a database schema, Diagrammer is designed to stay out of your way and let you focus on your ideas.

## What Makes Diagrammer Different?

### It's Fast — Really Fast

Most browser-based diagram tools start to struggle once you add a few hundred shapes. Diagrammer uses Canvas 2D rendering with spatial indexing (R-tree) to maintain **60fps with 10,000+ shapes**. That means:

- Smooth pan and zoom no matter how complex your diagram gets
- Instant shape selection and manipulation
- No lag, no waiting, no frustration

### Desktop & Web

Diagrammer runs as a **native desktop application** (Windows, Linux, macOS) using Tauri, giving you native file system access and system-level performance. It also works right in your browser for quick access without installation.

### Real-time Collaboration

Work with your team using **Protected Local mode** — one person hosts, others connect. Changes sync in real-time using CRDTs, so you'll never lose work due to conflicts.

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
| Smart connectors | Connectors auto-route and follow shapes when you move them |
| Rich text editor | Write formatted documentation right alongside your diagrams |
| Embedded files | Drag-and-drop PDFs, spreadsheets, and images onto the canvas |
| Whiteboard | Quick sticky-note brainstorming with Ctrl+I |
| Full undo/redo | Snapshot-based history — never worry about mistakes |
| Export anywhere | PNG, SVG, PDF, JSON, and .diagrammer archives |
| Themes | Dark and light themes with customizable style profiles |
| Offline-first | Works without internet, syncs when you reconnect |

## What's Next?

This documentation is organized to help you get productive quickly:

1. **[Installation](./installation)** — Download or build Diagrammer
2. **[Quick Start](./quick-start)** — Create your first diagram in under five minutes
3. **[Interface Tour](./interface-tour)** — Learn what every part of the screen does

After that, explore the **[Guides](/guide/canvas-navigation)** to go deeper into any feature.
