---
title: Sequence Diagrams
description: Model interaction over time between actors, objects, and systems — lifelines, activations, guard conditions, and message numbering.
---

# Sequence Diagrams

A sequence diagram answers a question class and use case diagrams can't: *in what order do these things talk to each other?* It reads top-to-bottom as a timeline of messages between participants.

## The building blocks

1. Open the Shape Picker and switch to **UML Sequence Diagrams**
2. Place a **Lifeline** for each participant — an actor, object, or system. Lifelines come in variants (person, system, external) so you can tell participants apart at a glance
3. Connect two lifelines with a connector to represent a message; drag downward as the interaction progresses — time flows down the page
4. Add an **Activation** bar on a lifeline to show it's actively doing work in response to a message; activations can nest when a call triggers another call before returning
5. Use a **Fragment** frame to wrap a group of messages under a condition — loop, alt (if/else), opt (optional), par (parallel), break, or critical
6. Mark the end of a participant's life with a **Destruction** marker (an X)

Smaller supporting shapes — **State Invariant**, **Time Constraint**, **Coregion**, and **Continuation** — cover more specialized timing and state-assertion notation when a diagram needs it.

## Giving messages meaning

Connectors between lifelines carry sequence-specific semantics, set in the Property Panel once a connector is selected:

- **Synchronous vs. asynchronous** — a synchronous call blocks until it returns (filled arrowhead); an asynchronous one doesn't (open arrowhead). Set this via the connector's start/end sequence marker.
- **Reply** — a dashed return message, distinct from an outbound call.
- **Create / destroy** — a message that instantiates or tears down a participant.
- **Lost / found** — a message whose sender or receiver isn't shown on the diagram.

**Guard conditions** — the bracketed text you often see next to a message, like `[amount > 100]` — describe the condition under which a message is sent. Set it from the connector's properties; DocuShark positions it near the start of the arrow automatically.

**Message numbering** — for diagrams where the order matters more than the vertical position (or you're cross-referencing a written spec), turn on message numbers to label each connector `1:`, `2:`, `2.1:`, and so on.

**Self-messages** — when a participant calls itself, the connector automatically loops out and back rather than trying to connect a lifeline to itself in a straight line.

## A typical flow

A request/response between two services usually looks like: lifeline for the caller, lifeline for the callee, a synchronous message down, an activation bar on the callee while it works, a reply message back, activation ends. Wrap the whole thing in an `alt` fragment once you need to show the error path too.

## See also

- [UML & ERD Diagrams](./uml-and-erd) — for structural diagrams that don't involve a timeline
- [Connectors](./connectors) — general routing and arrow styling
- [Shape Libraries](./shape-libraries) — the full generated shape catalog
