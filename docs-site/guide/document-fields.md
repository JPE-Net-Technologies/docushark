---
title: Document Fields
description: Reusable values you define once and reference throughout a DocuShark document — version numbers, names, dates, and more.
---

# Document Fields

Document fields are reusable values you define once and reference throughout your
prose. Define a field like `project` or `version`, drop <code v-pre>{{project}}</code> wherever you
need it, and every reference shows the current value. Change the value once and the
whole document updates.

## Why Use Fields

- **Stay consistent** — a product name, client, or version number lives in one
  place instead of being retyped (and mistyped) across the document.
- **Reuse a template** — write a document once with fields, then update the values
  to retarget it.
- **One edit, everywhere** — change a field's value and every <code v-pre>{{name}}</code> reference
  repaints instantly.

## Using a Field

In the document editor, reference a field inline as <code v-pre>{{name}}</code>. It renders as a
live element showing the field's current value — not as plain text — so it always
reflects the latest value rather than a stale copy.

Manage your fields in the **Fields manager**, where you set each field's name and
value.

### Built-in Fields

Some fields are computed for you, so you don't have to maintain them — for example,
date values like `today` and `now` resolve automatically wherever you reference
them.

## Fields in Exports and Collaboration

Field references resolve to their current values when you export (for example, to
PDF), so a shared or printed document reads naturally with no <code v-pre>{{...}}</code> markers
left behind. In a collaborative document, field values sync to everyone, so the
whole team sees the same resolved content.

## Setting Fields With AI Agents

Fields are part of DocuShark's [MCP surface](../developer/mcp-agent-recipes): an AI
agent can list a document's fields and set their values while drafting for you —
handy for filling a templated document from a prompt. See the
[AI Agents (MCP)](../developer/mcp-agent-recipes) page to connect one.
