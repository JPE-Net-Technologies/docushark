---
title: Draw
description: The canvas from top to bottom — moving around, drawing and arranging shapes, labels and styles, connectors, shape libraries, software diagrams and the whiteboard.
---

<script setup>
import { data } from './shape-libraries.data.ts'
</script>

# Draw

Canvas pages are for diagrams: a flowchart, an architecture, a data model, a sequence of calls or a quick sketch. A canvas has no edges, and it stays smooth with thousands of shapes. Click **Canvas** at the top to give it the whole window, or **Split** to keep your writing beside it.

## Move around {#move-around}

| To | With a mouse | With a trackpad | With the keyboard |
|---|---|---|---|
| Pan | Scroll; `Shift`+scroll moves sideways. Or drag with the middle button. | Scroll with two fingers | `W` `A` `S` `D`, or the arrow keys when nothing is selected |
| Zoom | `Ctrl`+scroll (`Cmd` on a Mac), towards the pointer | Pinch | `Q` and `E` |

The **Pan** tool (`H`) lets you drag the view without selecting anything. On some Linux systems a trackpad pinch doesn't zoom; `Q` and `E` always do.

The zoom controls sit at the canvas's bottom right. **−** and **+** step the zoom, clicking the percentage returns to 100%, and **Zoom to fit** frames every shape. Press and hold the percentage to see the whole diagram, and let go to return to where you were.

The **minimap** button beside them shows the whole page in miniature. Drag the outlined box to move the view, click elsewhere on the minimap to glide there, or scroll over it to zoom. It's most useful on large diagrams.

**Grid and guides.** A moving shape snaps to the grid and to other shapes: pink dashed **smart guides** show when its edges or centre line up with another shape's. **Settings → Appearance → Grid opacity** sets how visible the grid is; at 0% it's hidden, though shapes still snap to it.

## Draw shapes {#tools}

The tool row above the canvas holds the tools. Rest the pointer on one for its name and shortcut.

| Tool | Key | How to use it |
|---|---|---|
| **Select** | `V` | Click a shape to select it; `Shift`+click adds or removes one; drag across empty canvas to select an area. |
| **Pan** | `H` | Drag to move the view. |
| **Rectangle** | `R` | Drag to draw. Hold `Shift` for a square. |
| **Ellipse** | `O` | Drag to draw. Hold `Shift` for a circle. |
| **Line** | `L` | Drag from start to end. |
| **Connector** | `C` | Drag from one shape to another. See [Connectors](#connectors). |
| **Text** | `T` | Click where the text should go, and type. |
| **Shape library** | | Pick from flowchart, UML, ERD and other shapes. See [Shape libraries](#shape-libraries). |
| **Insert icon shape** | | Pick from cloud-provider and technology icons. |
| **Embed files** | | Add files to the canvas. See [Write → Files](./write#files). |

Right-click empty canvas for **Paste here**, **Add text here** and **Add shape here** (a rectangle, an ellipse or a diamond), plus **Undo**, **Redo**, **Select all**, **Zoom to fit** and **Zoom to 100%**.

## Select, move and arrange {#arrange}

- **Move** a selection by dragging it. The arrow keys nudge it; hold `Shift` for bigger steps.
- **Resize** by dragging a handle. Hold `Shift` to keep the proportions; some library shapes and icons always keep theirs.
- **Rotate** by dragging the round handle above the shape. Hold `Shift` to turn in steps of 15°.
- **Copy and paste** with `Ctrl+C` and `Ctrl+V`; a pasted copy lands slightly offset so you can see it.
- **Group** shapes with `Ctrl+G` and ungroup them with `Ctrl+Shift+G`, or right-click. Groups can hold groups. Double-click a group to work on a shape inside it; the status bar shows **In group**, and its **×** takes you back out.
- **Align and distribute:** select two or more shapes, and Properties shows buttons to line them up by their edges or centres, or space them evenly. The same actions are in the command palette (`Ctrl+K`).
- **Tidy a diagram** in one step: select a shape, press `Ctrl+Shift+A` to select everything connected to it, then `Ctrl+Shift+L` to lay it out from top to bottom. **Auto-layout selection (left to right)** is in the command palette.
- **Stacking:** right-click a shape and choose **Bring to Front** or **Send to Back**, or drag it in the **Layers** panel.

Right-click a shape for everything else you can do with it: group and ungroup, **Select connected**, stacking, **Save to Library…**, **Export Selection…** and **Delete**.

## Text and labels {#text-and-labels}

**Label a shape** by double-clicking it and typing. **Enter** keeps the label, **Shift+Enter** starts a new line, and **Escape** cancels the edit; clicking elsewhere keeps it too. Connectors take labels the same way. A group's label goes under **Label** in Properties.

**Equations:** start a label with `=` and the rest is read as LaTeX. For example, `=\sum_{i=1}^{n} x_i` draws the sum.

**Fonts.** Shapes use the [document font](./write#document-font) until you give one its own. In Properties, choose **Font** under **Label**, or under **Text** for a text box:

- **Document font**, which follows the document's font;
- **Inter**, **Source Serif 4** or **JetBrains Mono**;
- **Caveat**, a handwriting font for notes and sketches.

The **Label** section also sets the size, colour and background of the text, can shrink text to fit its shape, and can nudge the label off centre.

## Style shapes {#style}

Select a shape and the **selection bar** appears above it:

- **Style profiles** you used last: rest on one to preview it on the canvas, click it to apply it, or use the arrow for the full list.
- **Colours:** fill, outline and text, for whichever the selection has.
- **More:** opens **Properties**, which then follows your selection until you close it.

**Properties** shows everything about the selection: its **Style** profile, its **Appearance** (fill, outline and its width, opacity, and for rectangles, rounded corners), its **Label**, an **Icon**, and its **Position**, rotation and **Size**. Groups add a background pattern and a shadow. With several shapes selected, a change applies to all of them.

Every colour control opens the same picker, here and in your writing:

- A clearing choice comes first: **No fill**, or **Automatic** for text, which turns white on a dark fill and black on a light one so the label stays readable when you recolour the shape. (Automatic text prints black in PDFs.)
- The palette: ten colour families in five shades each.
- Your recent colours, shared between the canvas and your writing.
- A field for any colour (`#ff6600`, `#f60`, `rgb(255, 102, 0)` or a name such as `crimson`), and **Custom** for choosing one by eye.

If you'd rather not see the bar, turn off **Selection bar** in **Settings → General**; selecting a shape then opens Properties.

To save a look and reuse it across shapes and documents, see [Style profiles](./make-it-yours#style-profiles).

## Connectors {#connectors}

![Rounded process boxes joined by right-angled connectors, with the Properties panel showing a connector's routing mode, connector type, line style, arrows and label.](/screenshots/connectors-pipeline.png)

A connector links two shapes and stays attached as you move them.

**Draw one** with the **Connector** tool (`C`): drag from one shape to another. A shape's connection points are the middle of each side and its centre; the corners are resize handles. UML classes and ERD entities also have a point for each row.

**Shape its path** in Properties, under **Routing**:

- **Orthogonal**, the default: right angles that route around shapes, and re-route as you move things. The safe choice for flowcharts and architecture.
- **Straight:** the shortest line between the two ends.
- **Curved:** a smooth curve, which often reads better for loose relationships.

If a path looks awkward, switching its routing is usually the quickest fix. **Rebuild all connector routes**, in the tool row, re-routes every connector on the page.

**Ends and meaning.** Under **Connector Type**, **Arrows** gives you a line style and an arrowhead for each end: one arrow reads as a flow, two as a two-way link, none as a plain association. **ERD** sets the cardinality at each end, and **UML** the relationship, such as inheritance or composition. The [Shape properties](/developer/shape-properties) reference lists every option.

**Label a connector** by double-clicking it; Properties sets where along the path the label sits.

**Draw the same kind again.** The arrow beside the Connector tool picks the style new connectors start with: the routing, arrows or UML, and ERD presets. DocuShark remembers your last choice.

## Shape libraries {#shape-libraries}

**Shape library** in the tool row opens the shape picker. Browse by category or search, and click a shape: it appears in the middle of your view, ready to drag into place. (A shape from one of your own libraries is placed where you next click.) **Insert icon shape** does the same for icons.

DocuShark comes with {{ data.libraryShapeCount }} diagram shapes in these libraries:

<table>
  <thead>
    <tr><th>Library</th><th>Shapes</th><th>What it's for</th></tr>
  </thead>
  <tbody>
    <tr v-for="cat in data.libraryCategories" :key="cat.category">
      <td>{{ cat.label }}</td>
      <td>{{ cat.count }}</td>
      <td>{{ cat.description }}</td>
    </tr>
  </tbody>
</table>

<details v-for="cat in data.libraryCategories" :key="cat.category + '-detail'">
  <summary>{{ cat.label }}: every shape</summary>
  <ul>
    <li v-for="shape in cat.shapes" :key="shape.name">
      <strong>{{ shape.name }}</strong><span v-if="shape.description"> — {{ shape.description }}</span>
    </li>
  </ul>
</details>

It also has {{ data.iconCount }} icons: official cloud-provider service icons and common development tools, for architecture diagrams. They keep their brand colours in both the light and dark themes.

<table>
  <thead>
    <tr><th>Icon set</th><th>Icons</th></tr>
  </thead>
  <tbody>
    <tr v-for="cat in data.iconCategories" :key="cat.category">
      <td>{{ cat.label }}</td>
      <td>{{ cat.count }}</td>
    </tr>
  </tbody>
</table>

**Your own libraries.** Right-click a shape and choose **Save to Library…** to keep it in a library of your own. Manage your libraries in **Documents → Shape library**: create, rename and delete them, and export one as a `.json` file to share, or import one someone shared with you. The built-in libraries can't be deleted.

## Software diagrams {#uml-and-erd}

The UML and ERD libraries cover the notations engineers use. Each answers a different question about a system.

- **Class diagrams** (*what are the pieces?*): **Class** boxes with name, attribute and method compartments you edit in place, plus **Interface**, **Abstract Class**, **Enumeration**, **Package** and **Note**. Connect them and set the connector's UML relationship.
- **Use case diagrams** (*who does what?*): an **Actor** for each user or outside system, a **Use Case** for each goal, a **System Boundary** around what's in scope, and **Include** and **Extend** between use cases.
- **Activity diagrams** (*what's the workflow?*): **Action** steps between **Initial** and **Final** markers, **Decision** and **Merge** for branches, **Fork** and **Join** for work that runs in parallel, and **Swimlanes** for who owns each step. Start with those; signals, object nodes and the rest are there when a workflow needs them.
- **ERD** (*what's in the database?*): an **Entity** per table (a **Weak Entity** for a table that depends on another), **Attribute** and **Key Attribute** for columns, and either a **Relationship** diamond or a connector whose ERD type sets the cardinality, in crow's-foot notation.

### Sequence diagrams {#sequence-diagrams}

A sequence diagram shows the order in which things talk to each other, reading down the page as time passes.

1. Place a **Lifeline** for each participant. The variants (person, system, external) tell them apart at a glance.
2. Connect two lifelines with a connector for each message, working down the page.
3. Add an **Activation** bar where a participant is busy handling a message. Activations can nest.
4. Wrap messages in a **Fragment** for a condition: loop, alt, opt, par, break or critical.
5. End a participant's life with a **Destruction** marker.

Select a message to set its meaning in Properties: synchronous or asynchronous, a reply, create or destroy, lost or found. You can add a guard condition such as `[amount > 100]`, which DocuShark places beside the arrow, and turn on message numbers (`1:`, `2:`, `2.1:`). A message from a participant to itself loops out and back on its own.

A typical request: a lifeline for the caller and one for the service, a synchronous message down, an activation on the service while it works, and a reply back. Wrap it in an alt fragment to show the error path too.

Already have a diagram in Mermaid, draw.io or Excalidraw? [Import it](./export-import#import), and DocuShark lays it out for you.

## Whiteboard {#whiteboard}

The whiteboard is a layer of sticky notes for brainstorming, kept apart from your diagram. Open it from **Tools → Whiteboard**, or press `Ctrl+I` when you aren't typing in your writing (where `Ctrl+I` is italic).

- **Add Note** creates a note. Click it to type; `Ctrl+B` and `Ctrl+I` work inside.
- Drag a note to move it, and drag its corner to resize it.
- Each note's colour button offers twelve colours and your recent ones; the text adjusts to stay readable.
- The **×** on a note deletes it.

Close the whiteboard with `Escape`, by clicking outside it, or with `Ctrl+I`. Notes are saved with the document, and exports leave them out: the whiteboard is for drafting.
