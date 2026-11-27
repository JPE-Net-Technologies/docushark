---
title: "Tutorial: A research notebook"
description: Build a psychology study notebook in DocuShark, with real citations, a study-design diagram, a results table with statistics, the data file, and a concept map.
---

# Tutorial: A research notebook

A good research document keeps everything in one place: the write-up, a diagram of the design, the data, and the sources, all citable and all current. In this tutorial you'll build a small **psychology study notebook** and use the features researchers rely on most. It takes about twenty minutes.

**You'll build** a study notebook with a written report and real citations, a study-design diagram, a results table with statistics, the data file, and a concept map of the theory.

**You'll learn** fields, citations and a bibliography, a diagram beside your writing, equations, attached files, and showing a diagram inside your text.

![The finished study notebook in Split view: the written report on the left and the study's data and analysis diagram on the right.](/screenshots/example-research-project.png)

::: tip Want the finished version?
Download <a href="/examples/music-tempo-recall-study.docushark" download>the notebook as a <code>.docushark</code> file</a> and import it to explore the result, or see all the examples in the [gallery](/tutorials/examples).
:::

## 1. Create the notebook

In **Documents**, click **New**. Type `#`, a space, and the study's title, `Does Music Tempo Affect Recall?`; DocuShark names the document after this first heading.

Add **fields** for values you'll repeat. Choose **Insert → Insert field**, and in **Manage fields** create `course`, `lead` and `n` (the sample size). Insert one anywhere by typing <code v-pre>{{</code> and picking it; change its value later and every place updates. See [Fields](/guide/write#fields).

## 2. Write the report

Give the report its structure: headings for **Background**, **Method**, **Results** and **Discussion**. State the hypothesis in a callout (**Insert → Insert callout**): *Recall is highest in silence and falls as the tempo rises.* Write the procedure as a numbered list (type `1.` and a space).

## 3. Cite your sources

Don't type the reference list by hand; let DocuShark keep it right.

1. **Add references.** Paste a paper's DOI into the Background, and DocuShark turns it into a citation and adds the paper to the document's library. To add several at once, choose **Insert → Manage references** and paste them as BibTeX.
2. **Cite.** Where you make a claim, type `@` and pick the source. The citation appears in the document's style, such as `(Baddeley, 1992)`.
3. **List them.** Under a **References** heading, choose **Insert → Insert bibliography**. It lists only what you've cited and updates as you write. **Manage references** sets the style: APA, MLA, Chicago or Vancouver.

![A bibliography under a References heading, with a "Cited only / All references" switch above entries formatted in APA, each with its DOI.](/screenshots/citations-bibliography.png)

See [Citations](/guide/write#citations).

## 4. Diagram the study design

A picture of the design saves paragraphs. Click **Split** at the top to put the canvas beside your writing. Right-click the canvas's page tab, choose **Rename**, and call it `Study Design`.

Draw the flow: *Recruit → Randomly assign → Three tempo conditions → Encode → Recall → Score*. Choose **Rectangle** in the canvas's tool row and drag out a box for each step, double-clicking each to type its label and pressing **Enter**. Then choose **Connector** and drag from each box to the next. Select one box, press `Ctrl+Shift+A` to select the whole chain, and `Ctrl+Shift+L` to lay it out neatly.

In the Method section, point readers to it: *"The Study Design page shows the procedure at a glance."* Because the diagram lives in the document, not in a pasted screenshot, it's never out of date. See [Draw](/guide/draw).

## 5. Report the results

Put the numbers in a table (**Insert → Insert table**):

| Condition | Mean recall | SD | n |
|-----------|-------------|----|----|
| Silence | 13.4 | 2.6 | 20 |
| Fast (120 bpm) | 9.8 | 3.1 | 20 |

Write statistics as LaTeX: type `$F(2, 57) = 8.1,\ p < .01$` and it becomes a typeset equation. For an equation on its own line, put `$$` before and after it. See [Equations](/guide/write#equations).

## 6. Keep the data with the notebook

Drag your data file, such as a CSV of scores or the stimulus list as a PDF, onto the Study Design canvas. It becomes a card with a preview that opens in DocuShark, and it travels with the document. To mention it in the text instead, choose **Insert → Attach file** in the Method section. See [Files](/guide/write#files).

## 7. Map the theory

Sketch how the ideas connect on the canvas: four boxes, *Arousal → Attention → Encoding → Recall*, joined with connectors. Select all four and press `Ctrl+G` to group them. With the group selected, open **Properties** (**More** on the bar above it) and type `Theory` under **Label**.

Now show it in the Discussion: right-click there, choose **Insert Group**, and pick **Theory**. A picture of the map appears in your text, and its refresh button updates it after you change the diagram. See [Diagrams in your writing](/guide/write#diagrams).

## 8. Take it with you

If you're signed in, the notebook is in your workspace, so it's on every computer you use; on a phone, it opens in DocuShark's [phone layout](/guide/make-it-yours#phone). Before fieldwork with no signal, click **Make available offline** on its card in Documents. See [Offline](/guide/organize#offline).

## What you learned

You built a self-contained research notebook: fields, a cited write-up with a bibliography, a study-design diagram beside the text, a results table with statistics, the data file, and a concept map shown in your writing.

## Next steps

- [Export a PDF](/guide/export-import#pdf) with a cover page and a table of contents.
- [Connect an AI agent](/guide/share#connect-an-ai-agent) to draft a literature review, citations included, straight into the notebook.
- Browse the [example gallery](/tutorials/examples) for more finished documents.
