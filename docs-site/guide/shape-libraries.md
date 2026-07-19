---
title: Shape Libraries
description: DocuShark's built-in shape libraries — flowchart, UML, ERD, and cloud provider icons — generated from the app's own shape catalog.
---

<script setup>
import { data } from './shape-libraries.data.ts'
</script>

# Shape Libraries

DocuShark comes with a full shape and icon library out of the box — everything below is generated straight from the app's shape catalog, so it never goes stale.

## Browsing Shape Libraries

Open the **Shape Picker** from the toolbar:

1. Click the **Shapes** button in the toolbar
2. Browse categories in the sidebar tabs
3. Click a shape to select it as your current drawing tool
4. Click on the canvas to place the shape

## Core Shapes

The foundation shapes available in every document:

| Shape | Description |
|-------|-------------|
| **Rectangle** | Standard rectangular shape with optional rounded corners |
| **Ellipse** | Circles and ellipses |
| **Line** | Straight lines with optional arrowheads |
| **Text** | Text labels with full formatting |
| **Connector** | Smart auto-routing connectors |
| **Group** | Container for organizing shapes |
| **File** | Embedded files with preview thumbnails |

## Diagram Shape Libraries

DocuShark ships with {{ data.libraryShapeCount }} purpose-built shapes across flowchart, UML, and ERD notations.

<table>
  <thead>
    <tr><th>Category</th><th>Shapes</th><th>What it's for</th></tr>
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
  <summary>{{ cat.label }} — full shape list</summary>
  <ul>
    <li v-for="shape in cat.shapes" :key="shape.name">
      <strong>{{ shape.name }}</strong><span v-if="shape.description"> — {{ shape.description }}</span>
    </li>
  </ul>
</details>

## Cloud Provider & Technology Icons

DocuShark includes {{ data.iconCount }} icons — official cloud provider service icons plus common dev-tooling logos, perfect for architecture diagrams.

<table>
  <thead>
    <tr><th>Category</th><th>Icons</th></tr>
  </thead>
  <tbody>
    <tr v-for="cat in data.iconCategories" :key="cat.category">
      <td>{{ cat.label }}</td>
      <td>{{ cat.count }}</td>
    </tr>
  </tbody>
</table>

::: tip
Cloud icons use brand colors from each provider. They maintain their visual identity in both light and dark themes.
:::

## Custom Shape Libraries

Create your own reusable shape collections.

### Creating a Library

1. Select shapes you want to include
2. Right-click → **Add to Library**
3. Choose an existing library or create a new one
4. Name your shape

### Managing Libraries

Access library management from **Documents → Shape library**:

- **Create** new libraries
- **Rename** existing libraries
- **Delete** libraries (built-in libraries cannot be deleted)
- **Export** libraries as JSON files
- **Import** libraries from JSON files

### Sharing Libraries

Export your custom library:

1. Go to **Documents → Shape library**
2. Select your library
3. Click **Export**
4. Share the `.json` file

Import a shared library:

1. Go to **Documents → Shape library**
2. Click **Import**
3. Select the `.json` file

## Tips

- **Right-click** a shape on canvas → **Save to Library** to add it to a custom library
- After selecting a shape tool from the picker, click on the canvas to place it
- **Use the search** in the shape picker to find icons by name across all libraries
- For styling and theme options, see the [Styling & Themes](./styling) guide
