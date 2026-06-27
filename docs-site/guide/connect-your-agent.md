---
title: Connect an AI Agent
description: Connect Claude, Cursor, ChatGPT, or any MCP-compatible AI agent to DocuShark to author documents and diagrams.
---

# Connect an AI Agent

DocuShark speaks **[MCP](https://modelcontextprotocol.io)** — an open standard that lets
an AI agent author real documents for you: write prose, build diagrams, manage references,
all directly in your live document. You connect the agent you already use — Claude, Cursor,
ChatGPT, or your own — so there's nothing new to learn.

This guide gets you connected in a few minutes.

## 1. What you'll get

Once connected, you can ask your agent things like *"draft an architecture RFC with a system
diagram"* or *"turn these notes into an outlined document"* — and it writes them straight into
a DocuShark document, diagrams and all.

## 2. Get your endpoint

Pick your workspace's location to get the address — your **MCP endpoint** — that you'll paste
into your agent:

<RegionSelector />

::: tip Which location is mine?
It's the region you chose when you created your DocuShark Cloud workspace. Not sure? Toronto
(`yyz`) is the default. Running your own relay instead? See [Self-hosting](#self-hosting) below.
:::

## 3. Connect your agent

There are two ways to authenticate. Most people use **Option A**.

### Option A — Sign in (recommended)

Add your **MCP endpoint** to your client as a remote / custom MCP server. The first time your
agent connects, DocuShark walks you through signing in to your workspace — there's no token to
copy or paste. This is also the **only** option for **claude.ai on the web**.

### Option B — Use a token (advanced / self-host)

Some setups authenticate with a token instead of signing in (handy for a self-hosted relay or
a headless script). Send it as a header:

```
Authorization: Bearer <your-token>
```

For DocuShark Cloud, prefer Option A — signing in is simpler and nothing to manage.

### Per-client setup

::: tip Claude Desktop / Claude Code
Add DocuShark as a remote MCP server using your endpoint, then approve the sign-in prompt.
:::

Clients that use a JSON config (Cursor and others) follow this shape — paste your endpoint from
step 2 in place of the URL:

```json
{
  "mcpServers": {
    "docushark": {
      "url": "https://yyz.relay.docushark.app/mcp"
    }
  }
}
```

Your client's exact field names may differ slightly; the endpoint URL is the part that matters.
DocuShark's tools show up with a `docushark_` prefix (e.g. `docushark_create_document`).

## 4. Check it works

Ask your agent:

> "Create a DocuShark document called **Hello** with a short intro paragraph."

Then open [DocuShark](https://app.docushark.app) — your new document is right there, live.

## 5. Do more with recipes

Ready-made workflows ("skills") cover common jobs — an architecture RFC, a diagram from a
description, notes → a structured document, and more. On Claude they load automatically; with
other clients you paste a recipe into your system prompt. See
[AI Agents (MCP) & Recipes](/developer/mcp-agent-recipes) for the recipe list and the full
tool reference.

## Self-hosting

Running your own relay? Use its address instead of a Cloud region — for example
`http://localhost:9877/mcp` for a local relay, or `https://your-host/mcp` for a public one.
Everything else in this guide is the same.

::: tip Good to know
Your agent writes to your **workspace** (Cloud) documents. Local, on-device documents are
read-only over MCP — an agent can read them for context but won't change them.
:::
