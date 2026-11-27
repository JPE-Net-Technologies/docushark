---
title: Write
description: The writing editor from top to bottom — formatting, the document font, tables, images, equations, citations, fields, files and pasting.
---

# Write

Prose pages are where you write, from a quick note to a long report with tables, equations, citations and attached files. This page covers the editor from top to bottom; the canvas has its own page, [Draw](./draw).

## The basics {#basics}

Above the page sits the **ribbon**:

- **Undo** and **Redo** come first.
- **Home** holds text styles, the [document font](#document-font), formatting, colours, lists and alignment.
- **Insert** holds everything you can add: code, dividers, callouts, tables, equations, images, files, galleries, fields, citations and a bibliography.
- **Table** and **Image** tabs appear while your cursor is in a table or an image is selected. They never switch the ribbon over by themselves.
- **Find and replace** sits at the end (`Ctrl+F`).

Rest the pointer on any button for its name and shortcut. In a narrow window, such as Split, the buttons that don't fit move under **More tools** (**…**) at the end of the row.

Three shortcuts save trips to the ribbon:

- Type `/` at the start of a line for a menu of everything you can insert: headings, lists, quotes, code, dividers, callouts, tables, equations, images, files, galleries, fields, citations and a bibliography.
- Select some text and a small bar appears beside it with the common formatting. You can turn it off in **Settings → Appearance → Formatting on selection**.
- Right-click for what fits where you clicked: spelling suggestions and **Add to dictionary** on a misspelled word, **Open link**, **Edit link…** and **Remove link** on a link, plus **Insert**, the clipboard and formatting.

The status bar counts the page's words, or the selected words while you have a selection. Click the count for document statistics: words, characters, paragraphs and reading time.

## Formatting {#formatting}

| To get | Press | Or type at the start of a line |
|---|---|---|
| **Bold**, *italic*, underline | `Ctrl+B`, `Ctrl+I`, `Ctrl+U` | |
| `Inline code` | `Ctrl+E` | |
| Heading 1, 2 or 3 | `Ctrl+Alt+1`, `2` or `3` | `#`, `##` or `###` and a space |
| Body text | `Ctrl+Alt+0` | |
| Bulleted list | `Ctrl+Shift+8` | `-` and a space |
| Numbered list | `Ctrl+Shift+7` | `1.` and a space |
| Quote | | `>` and a space |

On a Mac, use `Cmd` for `Ctrl`. Task lists, strikethrough, subscript, superscript, links and alignment are on **Home**. In a list, `Tab` and `Shift+Tab` indent and outdent. Headings 4 to 6 are in the text style menu.

**Colour.** Text colour and highlight open the same colour picker the canvas uses, so a colour from your diagram is one click away. **Default** at the top returns text to the body colour without touching bold, italics or links. Type any colour into the field at the bottom (`#ff6600`, `#f60`, `rgb(255, 102, 0)` or a name such as `crimson`), and the picker shows a contrast reading so you can tell whether a pairing stays readable.

## The document font {#document-font}

A document has one font for all its text, chosen in the font box beside the text style on **Home**:

- **Inter**, the default: a clear sans-serif.
- **Source Serif 4**: a serif made for long reading.
- **JetBrains Mono**: a monospaced font.

The font applies to the whole document, and everyone working in a shared document sees it. Code keeps its monospaced font. Canvas shapes use the document font too, unless you give a shape its own ([Draw](./draw#text-and-labels)), and so do PDF exports. The fonts come with DocuShark, so a document looks the same on every computer, offline included.

## Tables {#tables}

Choose **Insert → Insert table**, or type `/table`, for a three-by-three table with a header row. While your cursor is in it, the **Table** tab appears with row, column and cell tools.

- Right-click a cell to insert or delete rows and columns, merge or split cells, and turn the header row or column on or off.
- The paint bucket on the **Table** tab colours a cell's background. Its picker leads with greys and pale tints, the shades that suit a header row or alternate stripes.
- `Tab` and `Shift+Tab` move between cells, and the arrow keys move as you'd expect.

## Images, figures and galleries {#images}

Choose **Insert → Upload image**, type `/image`, or paste a screenshot or copied picture. The image is saved into the document where your cursor is. Each image can be up to 10 MB.

- Drag an image's handles to resize it; it keeps its proportions.
- Click **Caption** on an image to give it a caption, which makes it a figure. Click it again to remove the caption.
- **Insert → Insert image gallery** sets several images side by side as one block.
- With an image selected, the **Image** tab offers **Replace image** and **Remove image**, and in a gallery, moving the image left or right.

## Equations {#equations}

Equations use LaTeX.

- **Inline:** type `$E = mc^2$` with dollar signs on both sides, or choose **Insert → Insert inline equation**.
- **On its own line:** type `$$` before and after, or choose **Insert → Insert block equation**, write the equation, and press `Ctrl+Enter` to insert it.

Shape labels on the canvas can be equations too; see [Draw](./draw#text-and-labels).

## Code, callouts and dividers {#blocks}

- **Code blocks** (**Insert**, or `/code`) highlight the syntax of many languages, and their text stays monospaced whatever the document font.
- **Callouts** set a note, tip or warning apart in a coloured box.
- **Dividers** draw a line between sections.

## Diagrams in your writing {#diagrams}

To show part of a canvas inside your writing, group the shapes on the canvas first ([Draw](./draw#arrange)). Then right-click in your writing, choose **Insert Group**, and pick the group. It appears as a picture of the diagram. After you change the diagram, use the refresh button on the picture to update it. Embedded groups are included in PDF exports.

## Citations {#citations}

![A bibliography under a References heading, with a "Cited only / All references" switch above entries formatted in APA, each with its DOI.](/screenshots/citations-bibliography.png)

Each document keeps its own reference library, and citations in the text stay linked to it.

**Cite a source.** Type `@` and pick from the document's references; keep typing to filter by author, title or year. The citation is linked rather than typed, so it updates with the reference and the citation style.

**Add references:**

- **Paste a DOI** (`10.xxxx/…` or a `doi.org` link) anywhere in your writing. DocuShark looks it up, adds the reference, and turns what you pasted into a citation. If the lookup is slow, the pasted text stays until it finishes, and a reference you already have isn't added twice.
- **Insert → Manage references** adds a reference by DOI, imports **BibTeX** or **CSL-JSON**, sets the citation style, and lists or removes references.
- **From a PDF:** open an attached PDF and click **Cite**. DocuShark finds the paper's DOI and adds the reference. If it can't find one, paste the DOI yourself, or add a basic reference from the file's details and complete it later.

**Bibliography.** **Insert → Insert bibliography** adds a formatted list of your sources. It shows only the references you've cited, so it stays accurate as you write; its **All references** switch lists the whole library. The styles are **APA**, **MLA**, **Chicago** and **Vancouver**.

References belong to the document. They go with it when you export, and everyone in a shared document sees the same library. An AI agent can add references and resolve DOIs too; see [Share and collaborate](./share#connect-an-ai-agent).

## Fields {#fields}

A field is a value you define once and use throughout the document, such as a product name, a client or a version number. Change it once and every place that shows it updates.

- Type <code v-pre>{{</code> and pick a field to insert it.
- **Insert → Insert field** opens **Manage fields**, where you create fields, change their values and insert them.
- Two fields are built in: `today` (today's date) and `now` (the date and time).

Fields show their values in exports, never the braces, and everyone in a shared document sees the same values. That makes fields handy for templates: write the document once, then change the values to reuse it. An AI agent can set fields for you; see [Share and collaborate](./share#connect-an-ai-agent).

## Files {#files}

PDFs, spreadsheets, images, audio, video and any other file can live in a document and travel with it.

**In your writing**, choose **Insert → Attach file** (or type `/file`). The file appears as a small chip that can sit mid-sentence or in a table cell; click it to open the file.

**On the canvas**, drag files from your computer onto it, click **Embed files** (the paperclip) in the canvas's tool row, or right-click an empty spot and choose **Embed file…**. Each file becomes a card with a preview, which you can move and resize like any shape. Several files dropped at once arrange themselves in a grid.

**Open a file** by clicking its chip or double-clicking its card. The viewer shows the file with its size and type, and a **Download** button. On a large screen, the pop-out button detaches the viewer into a floating panel you can move and resize, so you can read while you write.

| File | What the viewer offers |
|---|---|
| PDF | Continuous scrolling, text selection, search (`Ctrl+F`), the outline, zoom, bookmarks (`B`) and an immersive full-screen mode |
| Spreadsheet (`.xlsx`, `.csv`) | Every sheet, with tabs, fast on large data |
| Image | Full resolution, with zoom and pan |
| Audio and video | A player, for the formats your system plays |
| Text (`.txt`, `.md`, `.log` and similar) | The text with line numbers |
| Anything else | The file's details, and a download |

The PDF viewer reopens on the page you left. It can **dim pages** in the dark theme, **Cite** the paper ([Citations](#citations)), and **send a page to the canvas** as an image you can draw on.

**Replace a file** while keeping its place: right-click its card and choose **Replace File**, or use **Replace** in Properties or the viewer. **Settings → Storage** lists every file with its size and the documents that use it, and clears files nothing uses any more.

Each file can be up to 50 MB. In a shared document, files sync to everyone, with a progress notice while they transfer.

## Copy and paste {#copy-and-paste}

**From Word, Google Docs and the web,** pasting keeps the structure: headings, bold and italics, links, lists and tables. Styling that wouldn't suit your document, such as the source's black text, is left out, so pasted text stays readable in the dark theme; colours chosen on purpose are kept. Pasted images are saved into your document. Two kinds can't be, and DocuShark tells you when that happens: images in a selection copied from desktop Word (add them with **Upload image**), and images from a website that blocks copying (they stay linked to that website).

**Paste without formatting** with `Ctrl+Shift+V` (`Cmd+Shift+V` on a Mac), or from the right-click menu.

**Copy in another format:** right-click a selection and choose **Copy as → Plain text** (list markers and table rows kept) or **Copy as → Markdown** (GitHub-flavoured, with headings, lists, tables, code and math). A plain **Copy** keeps the formatting and images, for pasting into Word or an email.

::: tip
Some browsers don't let a menu read the clipboard. If **Paste** in the right-click menu doesn't work, paste with the keyboard.
:::

## More than one page {#pages}

A document can hold several prose pages, each with its own tab. Adding, renaming, colouring and nesting pages is covered in [Organize](./organize#pages).
