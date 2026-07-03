---
title: Self-Hosting Overview
description: Self-hosting DocuShark's sync server is an advanced, not-yet-officially-supported path — here's what exists today and where it's headed.
---

# Self-Hosting

::: warning Future — not officially supported yet
Self-hosting isn't a supported product today. DocuShark's goal is a lean, customizable open-source image — free of DocuShark Cloud's account, billing, and managed features — that gives you full control over your own storage, on your own hardware. What follows documents the advanced, do-it-yourself path that exists in the code right now; it isn't polished, and it may change without notice.
:::

## What works today (DIY)

The sync server that powers DocuShark workspaces is open source, and you can already run it yourself: a Docker container or a bare-metal binary, bring your own OIDC identity provider, and filesystem storage. See [Running It](./running-the-relay) to get one up.

## What's planned

A polished, versioned self-host release — a real "download and run" image, not a DIY assembly of a Docker command and a hand-written config file. The [Current Limitations](./scope-and-trust) page lists what's not there yet; each of those is roadmap, not a permanent ceiling.

## Connecting an agent to a self-hosted setup

If you're running your own setup and want an AI agent to connect over MCP, use its address instead of a DocuShark Cloud region — for example `http://localhost:9877/mcp` locally, or `https://your-host/mcp` for a publicly reachable one. Everything else in [Connect an AI Agent](../guide/connect-your-agent) is the same.

## See also

- [Running It](./running-the-relay) — Docker and bare-metal setup
- [Configuration](./configuration) — config file and environment variables
- [Authentication](./authentication) — bringing your own identity provider
- [Current Limitations](./scope-and-trust) — what's out of scope today, and the trust model
