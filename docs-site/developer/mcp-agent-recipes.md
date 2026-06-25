# AI Agents (MCP) & Recipes

DocuShark ships an **MCP server** (in the relay) — a precise, high-performance
toolset that lets an AI agent author real documents for you: write prose, build
diagrams, manage references, all surgically against the live document. Because
[MCP](https://modelcontextprotocol.io) is an open standard, you drive it from
**whatever agent harness you already use** — Claude.ai, Claude Code/Desktop,
Codex, Cursor, ChatGPT, or your own — rather than learning a new one.

## Connect your agent

::: tip New here?
For a step-by-step setup (with a picker that gives you the exact endpoint URL for your
workspace), start with the [**Connect an AI Agent**](/guide/connect-your-agent) guide. This
page is the deeper reference.
:::

1. **Connect your agent** to a relay's MCP endpoint (`/mcp`). The setup differs per
   client — see the connection matrix in the
   [skills/CONNECTING.md](https://github.com/JPE-Net-Technologies/docushark/blob/master/skills/CONNECTING.md)
   guide. In short:
   - **Claude Code / Claude Desktop** and the **OpenAI API / ChatGPT Developer Mode**
     accept a bearer token.
   - **claude.ai (web)** currently uses OAuth-only connectors (no bearer field), so
     use Claude Desktop/Code there for now.
2. **Load a recipe.** The [skills library](https://github.com/JPE-Net-Technologies/docushark/tree/master/skills)
   has ready-made workflows. On Claude they're auto-loading `SKILL.md` skills; on
   OpenAI you paste a recipe's body into a Custom GPT / system prompt.

## The recipes

| Recipe | What it produces |
|---|---|
| **architecture-rfc** | A design RFC with a system diagram. |
| **document-codebase-module** | A module reference: prose + a component diagram. |
| **diagram-from-description** | A clean, auto-laid-out diagram from a description. |
| **meeting-notes-to-doc** | A structured, outlined document from raw notes. |

Browse them in the repo:
[`skills/`](https://github.com/JPE-Net-Technologies/docushark/tree/master/skills).

## The tool surface

The authoritative reference for every MCP tool (params, returns, the
`generate_diagram` node/edge DSL, the Markdown prose contract) lives in
[`relay/docs/mcp/README.md`](https://github.com/JPE-Net-Technologies/docushark/blob/master/relay/docs/mcp/README.md).
Recipes target that surface; write your own against it the same way.

> **Note:** MCP writes target *team* documents (local documents are read-only over
> MCP), and shape styling is set inline per shape — saved style profiles are a
> client-side feature not exposed over MCP.
