---
title: Start here
description: What DocuShark is, how to open it, your first document in five minutes, and how documents, pages and workspaces fit together.
---

# Start here

DocuShark keeps your writing, your diagrams and your files together in one document. Write a design note and draw its architecture on a canvas beside it, keep research notes with the papers you cite, or plan a project with the spreadsheet it depends on. It works offline, and it stays fast as a document grows.

This page takes about ten minutes: how to open DocuShark, a first document, the screen, and the few ideas everything else builds on. To begin from your kind of work instead, see [Start with what you do](./start-with-what-you-do).

## Get DocuShark {#get-docushark}

- **In your browser.** Open [app.docushark.app](https://app.docushark.app). There's nothing to install, and you always have the latest version. Documents you make without signing in stay on your device and work offline.
- **As an app.** Most browsers can install DocuShark so it opens in its own window. In Chrome or Edge, use the install icon in the address bar. In Safari on a Mac, choose **File → Add to Dock**. On a phone or tablet, choose **Share → Add to Home Screen**.
- **On the desktop.** A native app for Windows, macOS and Linux runs the same editor, and can keep documents only on your computer. Installers aren't published yet, so for now you [build it from source](/developer/project-setup#build-the-desktop-app).

When a new version is out, DocuShark says **A new version of DocuShark is available** and waits for you to click **Reload**, so an update never interrupts your work.

## Your first document {#first-document}

1. **Create it.** DocuShark opens on **Documents**, your library. Click the gold **New** button. If you're signed in, the document goes into your workspace and syncs; otherwise it's a local document on this device. The arrow beside **New** lets you choose.
2. **Write.** The document opens ready for writing. Start with a heading (type `#` and a space) and DocuShark names the document after it; **Undo** in the message keeps it untitled. Format with the ribbon above the page.
3. **Draw.** Click **Split** at the top to put a canvas beside your writing, or **Canvas** to give it the whole window. Choose **Rectangle** in the tool row above the canvas and drag to draw one, then draw a second. Choose **Connector** and drag from one rectangle to the other.
4. **Label and style.** Choose **Select**, double-click a shape, type its label and press **Enter**. Click a shape and a small bar appears above it with its style and colours; **More** on that bar shows every property.
5. **Keep it.** DocuShark saves as you go. A check mark beside the document's name means everything is saved, and `Ctrl+S` (`Cmd+S` on a Mac) saves at once. To hand it to someone, open **Share** at the top: **Export to PDF…** makes a PDF, and in a workspace you can share the document itself ([Share and collaborate](./share#share-a-document)). For images and files, see [Export and import](./export-import).

**Documents**, at the top left, always takes you back to your library.

## Find your way around {#find-your-way-around}

Across the top of the window, from left to right:

| | |
|---|---|
| **Documents** | Your library: every document, your collections and the Trash. |
| The document's name | Click it to rename the document. The mark beside it shows whether everything is saved. |
| **Write · Split · Canvas** | What fills the window: your writing, both side by side, or the canvas. `Ctrl+Shift+\` cycles them. |
| The layout button | How much tooling is on screen and which panels show. It reads **Relaxed** at first. |
| **Tools** | Import a diagram, export a PDF, open the whiteboard, or open the command palette. |
| **?** | These docs. |
| **Settings** | Everything you can adjust. See [Make it yours](./make-it-yours). |

Above your writing are its page tabs and the **ribbon**: **Home** for formatting and **Insert** for tables, images and other blocks. Above the canvas are the canvas's page tabs and its tool row: Select, Pan, Rectangle, Ellipse, Line, Connector, Text, shape libraries, icons and files. Zoom controls and a minimap sit at the canvas's bottom right.

Three panels open from the layout button: **Properties** shows everything about what you've selected, **Layers** lists the shapes in stacking order, and **Navigator** lists every page. At the bottom of the window, the status bar counts words while you write (click the count for document statistics) and shapes while you draw.

`Ctrl+K` (`Cmd+K` on a Mac) opens the **command palette**: every action by name, including the ones without a button.

## How it fits together {#how-it-fits-together}

**Documents and pages.** A document is what you open, name and share. It's made of pages of two kinds, **writing pages** and **diagrams**, and each kind has its own tabs. A new document starts with one of each. Treat pages as the sections of one piece of work, such as "Overview", "Data model" and "API flow", so one document holds the whole thing. See [Organize](./organize#pages).

**Writing and drawing side by side.** Write, Split and Canvas change what you see, never the document. The **layout** decides how much tooling surrounds it:

| Layout | Best for |
|---|---|
| **Relaxed** (the default) | Writing first, with the canvas one click away. |
| **Designer** | The canvas first, with your writing one click away. |
| **Technician** | Writing and canvas side by side; panels fly out when you need them. |
| **Power** | Everything on screen at once. |

Switch with the layout button or `Ctrl+Shift+1` to `4`. See [Make it yours](./make-it-yours#layouts).

**Files live in the document.** Add a PDF, a spreadsheet, an image or a dataset and it travels with the document, including when you export it. See [Write](./write#files).

**Collections and tags.** A collection is where a document lives, like a folder, and a document sits in one collection at most. Tags say what a document is about; it can carry as many as you like, and search finds them with `#`. See [Organize](./organize#collections-and-tags).

**Local or workspace.** This decides where a document is kept and who can reach it.

| | Local document | Workspace document |
|---|---|---|
| Kept | On this device | In your workspace, and on each device you use |
| Offline | Always | Once it's available offline; changes sync when you reconnect |
| Sharing and live editing | No, it's yours alone | Yes |

Sign in to use a workspace. A local document can move into one when you're ready to share it. See [Share and collaborate](./share).

## Where to next {#where-next}

- [Start with what you do](./start-with-what-you-do): a short path for research, engineering, personal notes or AI agents.
- The guide, one page per job: [Write](./write), [Draw](./draw), [Organize](./organize), [Share and collaborate](./share), [Make it yours](./make-it-yours), [Export and import](./export-import) and [Keyboard shortcuts](./keyboard-shortcuts).
- [Tutorials](/tutorials/research-project): a whole document, start to finish.
