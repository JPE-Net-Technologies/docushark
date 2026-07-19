---
title: "Tutorial: A Research Project Notebook"
description: Build a psychology study notebook in DocuShark — prose with real citations, a study-design diagram, a results table with math, an embedded data file, and a concept mind-map.
---

# Tutorial: A Research Project Notebook

A great DocuShark document for a researcher keeps everything in one place: the
write-up, the diagram of the design, the data file, and the sources — all
citable, all in sync. In this walkthrough you'll build a small **psychology study
notebook** and pick up the features researchers lean on most.

**What you'll build:** a one-document study notebook — a written report with real
inline citations, a study-design diagram on its own canvas page, a results table
with a stats formula, an embedded data file, and a concept mind-map.

**You'll learn:** document fields, **citations** (a reference library + inline
cites), **linking a diagram** page from your prose, embedded files, math, and a
**mind-map via Add Group**.

**Before you start:** [open DocuShark](https://app.docushark.app) and skim
[How DocuShark Is Organized](/guide/concepts) if the pieces are new.

<!-- SCREENSHOT (hero): the finished study notebook in Split focus — the report on the left, the study-design diagram on the right -->

## 1. Create and title the notebook

From the **Documents** home, click **New** and rename it to your study — e.g.
`Does Music Tempo Affect Recall?`. Add a couple of **document fields** for values
you'll reuse: click the **Fields** control and define `Course`, `Lead`, and `n`
(sample size). Reference them in your prose as <code v-pre>{{Course}}</code> and
they update everywhere at once. See [Document Fields](/guide/document-fields).

## 2. Write the report

In the document editor, write the study up with real structure — headings, a
**hypothesis** as a block quote, and a numbered **Procedure**:

```
# Does Music Tempo Affect Recall?

> Hypothesis (H1): Recall is highest in silence and decreases as tempo rises.

## Background
## Method
## Results
## Discussion
```

The editor supports tables, LaTeX math, and callouts — everything a write-up
needs. See [Rich Text & Notes](/guide/rich-text-editor).

## 3. Cite your sources properly

Don't hand-type a reference list — use DocuShark's citation system so the
bibliography stays correct.

1. Open **Citations** and **add a reference** — paste a **DOI** and DocuShark
   fetches the details, or add it by hand.
2. In your Background, place an **inline citation** where you make a claim: it
   shows as `(Author, Year)` and links to the library entry.
3. Generate the **bibliography** under a References heading — it's built from the
   library and re-formats itself as you add sources.

See [Citations & References](/guide/citations) for DOIs, styles, and bibliographies.

<!-- SCREENSHOT: the Background paragraph with two inline (Author, Year) citations, and the generated bibliography below -->

## 4. Diagram the study design — and link to it

A picture of the design saves paragraphs. Add a **second canvas page** for it:
click **+** on the page tabs, name it `Study Design`, and sketch the flow —
*Recruit → randomly assign → three tempo conditions → encode → recall → score*.
Press `C` for the Connector tool to wire the steps together; DocuShark
auto-routes them.

Then **link the diagram from your prose** — in the Method section, write a line
like *"See the Study Design page for the flow at a glance."* Because the diagram
lives in the same document (not a pasted screenshot), it's always current. See
[Multi-Page Documents](/guide/multi-page-documents).

<!-- SCREENSHOT: the Study Design canvas page — a clean top-down experimental flow with the three conditions branching and rejoining -->

## 5. Report results with a table and math

Put your numbers in a table, and write statistics inline as LaTeX — type
`$F(2, 57) = 8.1,\ p < .01$` and it renders as a real equation. Block equations
go on their own line between `$$ … $$`.

| Condition | Mean recall | SD | n |
|-----------|-------------|----|----|
| Silence | 13.4 | 2.6 | 20 |
| Fast (120 bpm) | 9.8 | 3.1 | 20 |

## 6. Keep the data with the notebook

Drag your **data file** — a CSV of scores, a stimulus PDF — straight onto the
Study Design canvas. It's embedded in the document and travels with it, so the
evidence lives next to the analysis. See [Embedded Files](/guide/embedded-files).

## 7. Map the theory with a mind-map

To sketch how the ideas connect (*arousal → attention → encoding → recall*),
right-click on a prose page and choose **Add Group…** to start a **mind-map**
right in your notes — quick to reshape as your thinking evolves.

## 8. Read it anywhere — even your phone

Your notebook syncs to your workspace, so you can open it on another computer or
**install DocuShark on your phone** and read it on the bus. Mark it
[available offline](/guide/offline-and-sync) before a flaky-signal field trip, and
try the [mobile layout](/guide/mobile-preview) for small screens.

## What you learned

You built a self-contained research notebook: fields, a properly-cited write-up,
a linked study-design diagram, a results table with math, an embedded data file,
and a concept mind-map — synced across your devices.

## Next steps

- **[Tutorial: A Course Curriculum](/tutorials/course-curriculum)** — files as
  readings, and archiving each term.
- **[Citations & References](/guide/citations)** — DOIs, styles, and bibliographies.
- **[Connect an AI Agent](/guide/connect-your-agent)** — have an agent draft the
  literature review, cited, straight into your notebook.
