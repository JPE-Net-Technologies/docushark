---
title: "Tutorial: Diagram an AWS Architecture"
description: A guided walkthrough — build a clean AWS architecture diagram in DocuShark using cloud service icons, smart connectors, and auto-layout.
---

# Tutorial: Diagram an AWS Architecture

In this walkthrough you'll build a small but real **AWS architecture diagram** — a
serverless image-upload flow — using DocuShark's built-in cloud service icons,
smart connectors, and auto-layout. About 15 minutes.

**What you'll build:** a diagram of `Browser → CloudFront → S3` for static assets,
plus `API Gateway → Lambda → DynamoDB` for the API.

**You'll learn:** the shape picker and cloud icon library, placing and labelling
service icons, connecting them, tidying with auto-layout, theming, and exporting
a shareable image.

**Before you start:** [open DocuShark](https://app.docushark.app). If shapes and
connectors are new to you, the
[Design Doc tutorial](/tutorials/design-doc-with-diagram) is a gentler start.

## 1. New document, diagram-first

From the **Documents** home, click **New** and rename it `Image Service — AWS`.

This document is all canvas, so switch to the **Designer** layout — press
`Ctrl/Cmd+Shift+2`, or pick it from the layout selector chip in the toolbar.
Designer gives the canvas the whole screen. See [Layout Modes](/guide/layout-modes).

## 2. Open the cloud icon library

Click the **Shapes** button in the toolbar to open the **shape picker**. The
picker groups shapes into categories — flowchart, UML, ERD, and **cloud provider
icons** (AWS, Azure, GCP).

The fastest way in is **search**: type a service name (for example `S3`) in the
picker's search box to find its icon across every library.

<!-- SCREENSHOT: the shape picker open, cloud icons category visible, "S3" typed in the search box -->

::: tip
DocuShark ships hundreds of official cloud service icons, and they keep their
brand colours in both light and dark themes. See
[Shape Libraries](/guide/shape-libraries) for the full catalog.
:::

## 3. Place the services

Place six icons on the canvas — for each one, search it in the picker, click it,
then click on the canvas to drop it:

- `CloudFront`
- `S3`
- `API Gateway`
- `Lambda`
- `DynamoDB`

Add one plain **Rectangle** (`R`) labelled `Browser` as the entry point.
Double-click any icon to give it a label if you want (for example `Static assets`
under S3).

Don't worry about neatness yet — auto-layout handles it.

<!-- SCREENSHOT: the six services and the Browser box placed roughly on the canvas -->

## 4. Connect the flow

Press `C` (Connector). Hover a shape to reveal its **connection points**, click
one, then click a connection point on the next shape. Build two paths:

- **Static:** `Browser → CloudFront → S3`
- **API:** `Browser → API Gateway → Lambda → DynamoDB`

Label the key hops — click a connector's label area and type, e.g. `GET /img` on
Browser → CloudFront, and `query` on Lambda → DynamoDB.

<!-- SCREENSHOT: the services connected into the two labelled paths -->

## 5. Tidy with auto-layout

Select everything with `Ctrl/Cmd+A`, open the **command palette** (`Ctrl/Cmd+K`),
and search **"layout"** to run auto-layout. DocuShark arranges the services into a
clean, readable flow and re-routes the connectors. Move anything afterward and the
connectors stay attached.

<!-- SCREENSHOT: the finished AWS diagram after auto-layout — clean top-down flow -->

## 6. Make it yours

Give the diagram a consistent look:

- Select a shape and use the **Property Panel** to adjust fill, stroke, and text.
- Switch the whole document between light and dark, or apply a **style profile**,
  from the appearance controls. See
  [Styling & Themes](/guide/styling) and [Appearance](/guide/appearance).

## 7. Export a shareable image

Use **Export** to save the diagram:

- **PNG** or **SVG** for the current canvas — drop it in a wiki, a slide, or a PR.
- **PDF** if you've also written notes on a prose page.

See [Export & Import](/guide/export-import) for all formats.

## What you learned

You built a real cloud architecture diagram from DocuShark's icon library,
connected it with smart connectors, tidied it with auto-layout, themed it, and
exported it. The same flow works for Azure and GCP icons — or your own
[custom shape libraries](/guide/shape-libraries#custom-shape-libraries).

## Next steps

- **[Import a diagram](/guide/export-import)** — already have diagrams in Mermaid,
  draw.io, or Excalidraw? Bring them straight in.
- **[UML & ERD Diagrams](/guide/uml-and-erd)** — model classes and data with
  purpose-built notations.
- **[Connect an AI Agent](/guide/connect-your-agent)** — have an agent draft a
  diagram like this from a description.
