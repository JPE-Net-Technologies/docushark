---
title: Example gallery
description: Four finished DocuShark documents to download and explore (a research notebook, a course plan, a channel content plan and a lab protocol), and a diagram-first example of an AWS architecture.
---

# Example gallery

The quickest way to see what a DocuShark document can hold, with writing, diagrams, files and references together, is to open a finished one. Each example below is a `.docushark` file: the document and everything it uses, in one file. Each comes with a note on how it's built, so you can make your own.

## Open an example {#open}

1. Download the example's `.docushark` file.
2. In [DocuShark](https://app.docushark.app), open **Documents** and click **Import**, beside **New**. (On a phone, it's **Import a document…** in the menu beside **New**.)
3. Pick the file. It opens as a new document with all its pages and files, online or off.

An imported example is an ordinary document of your own: rename it, change it, or take it apart to see how it's made. The file you downloaded isn't touched.

## A research notebook {#research-notebook}

![The study notebook in Split view: the written report on the left and the study-design diagram on the right.](/screenshots/example-research-project.png)

A psychology study, *Does Music Tempo Affect Recall?*: a cited write-up, a study-design diagram on its own canvas page, a results table with statistics, and a concept map of the theory. The kind of document a researcher keeps for each study.

**Shows:** fields, citations and a bibliography, a diagram beside the text, equations, and a diagram shown inside the text.

<a href="/examples/music-tempo-recall-study.docushark" download>Download <code>music-tempo-recall-study.docushark</code></a> · [Build it step by step](/tutorials/research-project)

## A course plan {#course-curriculum}

![The course plan in Split view: the weekly schedule on the left and the map of how the units connect on the right.](/screenshots/example-course-plan.png)

An *Intro to Astronomy* course: a weekly schedule, the readings, a cited reading list, and a map of how the units build on each other. Reuse it each term by changing a few fields.

**How it's built:**

- **Fields** for the course, term and instructor, so next term's copy is a few edits ([Fields](/guide/write#fields)).
- The weekly schedule as a **table**, with a row per week and columns for the topic, reading and assignment.
- The readings attached as **files** on the canvas, so students open everything from one place, and the set texts cited from the document's **references** ([Files](/guide/write#files), [Citations](/guide/write#citations)).
- A **Course Map** canvas page: *Foundations → Solar System → Stars → Galaxies → Cosmology*, with connectors for prerequisites.
- A **showcase** area on the canvas for standout student work.
- At the end of each term, the plan exported as a `.docushark` file and kept in a **collection** of past terms ([.docushark files](/guide/export-import#docushark-files), [Collections](/guide/organize#collections-and-tags)).

<a href="/examples/intro-to-astronomy-course-plan.docushark" download>Download <code>intro-to-astronomy-course-plan.docushark</code></a>

## A channel content plan {#content-plan}

![The channel plan in Split view: the content pillars and publishing calendar on the left and the topic map on the right.](/screenshots/example-content-plan.png)

*Curious Minds*, a science channel's plan: content pillars, a publishing calendar, a performance log, a topic map and a production pipeline. Everything a creator usually spreads across five apps, in one document.

**How it's built:**

- **Fields** for the channel, quarter and host, and the content pillars as a list.
- A publishing calendar as a **table** (date, topic, format and status), and a **performance** table of past episodes with views and notes.
- A **topic map** on the canvas: each pillar branching into episode ideas, quick to rearrange as the backlog grows.
- A **Production Pipeline** canvas page: *Ideate → Research → Script → Record → Edit → Thumbnail → Publish → Promote → Analyze*, with a connector looping from Analyze back to Ideate.
- **Citations** for the claims made on screen, a primary source for each episode.

<a href="/examples/curious-minds-content-plan.docushark" download>Download <code>curious-minds-content-plan.docushark</code></a>

## A lab protocol {#lab-protocol}

![The protocol in the Power layout: the method notes on the left, the assay's workflow on the canvas with one step selected, and that step's Properties on the right.](/screenshots/example-cell-viability.png)

A *Cell Viability Assay* protocol: step-by-step method notes beside a workflow of the assay drawn with icons. A compact example of writing and a diagram supporting each other.

**Shows:** a procedure in prose, an icon-styled workflow, the Power layout with Properties docked, and style profiles ([Make it yours](/guide/make-it-yours#style-profiles)).

<a href="/examples/cell-viability-assay.docushark" download>Download <code>cell-viability-assay.docushark</code></a>

## An AWS architecture {#aws-architecture}

A diagram-first example, with no download: build it on a fresh canvas in about fifteen minutes. It's a serverless image service, with *Browser → CloudFront → S3* for images and *Browser → API Gateway → Lambda → DynamoDB* for the API.

1. **Make room.** Create a document, and press `Ctrl+Shift+2` for the **Designer** layout, which gives the canvas the window ([Layouts](/guide/make-it-yours#layouts)).
2. **Place the services.** Choose **Insert icon shape** in the canvas's tool row, search for `CloudFront`, and click it: the icon appears in the middle of your view, so drag it aside. Do the same for `S3`, `API Gateway`, `Lambda` and `DynamoDB`. Add a **Rectangle** labelled `Browser`.
3. **Connect them.** With the **Connector** (`C`), drag along both paths. Label the key steps, such as `GET /img` and `query`, by choosing **Select** and double-clicking each connector.
4. **Tidy it.** Select `Browser`, press `Ctrl+Shift+A` to select everything connected, and `Ctrl+Shift+L` to lay it out.
5. **Share it.** Press `Ctrl+A`, right-click a shape, and choose **Export Selection…** for a PNG for a wiki or a slide, or an SVG to edit further.

The same steps work with the Azure and Google Cloud icons. See [Draw](/guide/draw#shape-libraries) for every library.
