---
title: UML & ERD Diagrams
description: Model your system's structure — classes, use cases, activities, and database schemas — with DocuShark's UML and ERD shape libraries.
---

# UML & ERD Diagrams

If you're documenting a system rather than a process, DocuShark's structural diagram libraries cover the notations software engineers actually use: UML class diagrams, use case diagrams, activity diagrams, and Entity-Relationship diagrams for database schemas. Each one exists to answer a different question about your system.

## Class Diagrams — "what are the pieces, and how do they relate?"

Use a class diagram to document the shape of your codebase or API surface: classes, interfaces, and the relationships between them.

1. Open the Shape Picker and switch to the **UML Class Diagrams** category
2. Place a **Class** shape — it's a three-compartment box (name, attributes, methods) you can edit directly on the canvas
3. Add **Interface** shapes for contracts, **Abstract Class** for base types, and **Enumeration** for fixed value sets
4. Group related classes visually with a **Package** container
5. Connect classes with connectors — set the arrowhead to reflect the relationship (inheritance, composition, association)
6. Drop a **Note** shape anywhere you need a design rationale that doesn't belong on a class itself

Class diagrams work well as living documentation next to a [prose page](./rich-text-editor) describing the "why" behind the structure the diagram shows.

## Use Case Diagrams — "who does what with the system?"

Use case diagrams capture the system from the outside: actors and the goals they accomplish.

1. Place an **Actor** shape (the stick figure) for each user or external system
2. Place a **Use Case** shape (an ellipse) for each goal or capability
3. Connect actors to the use cases they participate in
4. Wrap related use cases in a **System Boundary** to show what's in scope
5. Use **Include** and **Extend** relations between use cases when one goal always (include) or sometimes (extend) triggers another

These are the fastest diagrams to sketch in a stakeholder meeting — start rough, refine the boundary once the scope is agreed.

## Activity Diagrams — "what's the workflow?"

Activity diagrams model a process as a flow of actions, decisions, and parallel branches — closer to a flowchart than a class diagram, but with UML's richer vocabulary for concurrency and lifecycle.

- **Action** nodes for individual steps, bounded by **Initial** and **Final** markers
- **Decision** and **Merge** diamonds for branching logic
- **Fork/Join** bars where work genuinely happens in parallel, not just branches
- **Swimlanes** to show which actor or system owns each step
- **Send/Receive Signal** shapes for asynchronous, event-driven steps
- Supporting nodes for more advanced modeling: object nodes, data stores, buffers, pins, and expansion regions

Start with just Action, Decision, and Swimlane — the rest are there when a workflow genuinely needs them, not a checklist to fill out.

## ERD — "what does the database look like?"

Entity-Relationship diagrams use Crow's Foot notation to document schemas.

1. Place an **Entity** shape per table; a **Weak Entity** (double border) for tables that only exist through another table
2. Add **Attribute** shapes for columns, and use **Key Attribute** (underlined) for primary keys
3. Connect entities with a **Relationship** diamond, or connect them directly and set the connector's cardinality in the Property Panel (one-to-many, many-to-many, and so on)

ERDs are usually the fastest of these four to keep in sync with reality — regenerate one whenever the schema changes rather than letting it drift.

## Bringing in an existing diagram

Already have a UML or ERD diagram in Mermaid or draw.io? See [Export & Import](./export-import) — DocuShark can bring it in and lay it out automatically.

## See also

- [Shape Libraries](./shape-libraries) — the full generated catalog of every shape in these libraries
- [Sequence Diagrams](./sequence-diagrams) — for modeling interaction over time, which these four notations don't cover
- [Connectors](./connectors) — routing, arrowheads, and cardinality
