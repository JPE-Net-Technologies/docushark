# Diagrammer

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Deploy Documentation](https://github.com/QR-Madness/diagrammer/actions/workflows/docs.yml/badge.svg)](https://github.com/QR-Madness/diagrammer/actions/workflows/docs.yml)
[![Build Release Artifacts](https://github.com/QR-Madness/diagrammer/actions/workflows/release.yml/badge.svg)](https://github.com/QR-Madness/diagrammer/actions/workflows/release.yml)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](https://github.com/QR-Madness/diagrammer/releases)
[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](https://github.com/QR-Madness/diagrammer/releases)

A high-performance diagramming and whiteboard application that handles **10,000+ shapes at 60fps**. Built with TypeScript, React, and Canvas 2D API. Runs as a desktop app (Tauri) or in your browser.

**[Download the latest release](https://github.com/QR-Madness/diagrammer/releases)**

<!-- ![Diagrammer Logo](Diagrammer.png) -->

## ✨ Features

- **🚀 High Performance** – Canvas 2D rendering with spatial indexing (R-tree) for buttery-smooth editing
- **👥 Real-time Collaboration** – Work together via Protected Local mode with CRDT-based sync (Yjs)
- **📦 Rich Shape Libraries** – Flowchart, UML, ERD shapes built-in, plus custom shape libraries
- **📄 Multi-page Documents** – Organize complex projects across multiple pages
- **✏️ Rich Text Editor** – Add formatted documentation alongside your diagrams
- **💾 Offline-first** – Full offline support with automatic sync when reconnected
- **🖥️ Desktop & Web** – Native desktop app (Windows, macOS, Linux) or browser-based
- **📤 Export** – PNG, SVG, JSON export with clipboard support

## 📖 Documentation

**[View the full documentation →](https://QR-Madness.github.io/diagrammer/)**

- [Getting Started](https://QR-Madness.github.io/diagrammer/getting-started/introduction/)
- [Installation](https://QR-Madness.github.io/diagrammer/getting-started/installation/)
- [Keyboard Shortcuts](https://QR-Madness.github.io/diagrammer/guide/keyboard-shortcuts/)
- [Architecture](https://QR-Madness.github.io/diagrammer/developer/architecture/)

## 🚀 Quick Start

```bash
# Install dependencies
bun install

# Start development server (web)
bun run dev

# Start desktop app development
bun run tauri:dev

# Run tests
bun run test

# Build for production
bun run build          # Web
bun run tauri:build    # Desktop
```

## 🏗️ Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop | Tauri v2 (Rust backend) |
| Runtime | Bun |
| Language | TypeScript (strict), Rust |
| UI | React 18 |
| Canvas | Canvas 2D API |
| State | Zustand + Immer |
| Collaboration | Yjs CRDTs |
| Rich Text | Tiptap |
| Spatial Index | RBush |
| Build | Vite, Cargo |

## 📁 Project Structure

```
/src
├── /engine          # Core canvas engine (Camera, Renderer, Tools)
├── /shapes          # Shape types and registry
├── /store           # Zustand stores (Document, Session, History)
├── /collaboration   # Yjs sync, WebSocket protocol
├── /ui              # React components
├── /math            # Vector and matrix utilities
└── /utils           # General utilities
/src-tauri           # Rust backend (Tauri)
/docs-site           # Documentation (Starlight)
```

## 📄 License

MIT
