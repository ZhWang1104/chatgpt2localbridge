<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <img src="./docs/assets/logo.png" alt="ChatGPT2LocalBridge logo" width="160" />
  <h1>ChatGPT2LocalBridge</h1>
  <p><strong>Let ChatGPT and Codex inspect approved local repositories through a safe, auditable MCP bridge.</strong></p>
  <p>
    <a href="https://github.com/ZhWang1104/chatgpt2localbridge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZhWang1104/chatgpt2localbridge/actions/workflows/ci.yml/badge.svg" /></a>
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" />
    <img alt="MCP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-1769e0.svg" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  </p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#large-repository-workflow">Large repositories</a> ·
    <a href="./docs/security.md">Security</a> ·
    <a href="./docs/operations.md">Operations</a>
  </p>
</div>

ChatGPT2LocalBridge is a self-hosted MCP server for approved local workspaces.
It exposes bounded file, repository, Git, skill, task, and diagnostic tools to
ChatGPT Custom Connectors and local MCP clients. The bridge runs on your
machine; ChatGPT never mounts your disk directly and can only call tools allowed
by the local policy.

> [!IMPORTANT]
> This enhanced fork is based on the original
> [`Harzva/chatgpt2localbridge`](https://github.com/Harzva/chatgpt2localbridge)
> project created by **Harzva**. The original authorship, Git history, project
> name, and MIT license are retained. This fork adds repository-scale coverage,
> resumable scans, AST symbols, CodeGraph-assisted context, fail-closed defaults,
> and a unified TypeScript runtime for the CLI, launchd service, and macOS app.

## What This Fork Adds

- A complete Git-tracked file manifest: every tracked path receives an explicit
  `indexed`, `binary`, `denied`, `symlink`, `missing`, or `failed` status.
- UTF-8-safe line and byte chunks for repositories too large for one model
  context, including large files and very long individual lines.
- Persistent, resumable scans where delivered chunks and acknowledged chunks
  are tracked separately.
- AST definition/reference indexing for TypeScript, JavaScript, and Python,
  including variables, parameters, properties, functions, classes, and types.
- Optional CodeGraph integration for dependency and relationship context.
- Snapshot identities bound to canonical path, branch, commit, dirty state,
  file hashes, and chunk hashes.
- Safe defaults: readonly tools, `workspace:read`, loopback-only HTTP, disabled
  shell, deny globs, and canonical-path checks that reject symlink escapes.
- One configuration directory, CLI setup/diagnostics, launchd persistence, a
  fixed Cloudflare Tunnel installer, and a portable macOS application bundle.

## How It Works

```text
ChatGPT / local MCP client
          │
          │ MCP over HTTPS + OAuth
          ▼
ChatGPT2LocalBridge on 127.0.0.1:3838
          │
          ├─ bridge.policy.json       authorization boundary
          ├─ Git manifest + chunks    completeness and raw source
          ├─ AST symbol index         definitions and references
          ├─ CodeGraph (optional)     relationships and impact context
          └─ approved local files     source of truth
```

The TypeScript build is the supported production engine. The Rust directory is
an experimental preview and is not used by the supported macOS or ChatGPT
Connector path.

## Quick Start

Requirements:

- Node.js 20 or newer
- Git
- macOS for launchd and the native application
- `rg` for fast search (optional; a bounded built-in fallback is included)
- `codegraph` for relationship context (optional)
- `cloudflared` only when exposing a fixed public connector URL

```bash
git clone https://github.com/ZhWang1104/chatgpt2localbridge.git
cd chatgpt2localbridge
npm ci
npm run build

node dist/index.js setup --root /absolute/path/to/your/repository
node dist/index.js install-service
node dist/index.js doctor
```

The setup command creates:

```text
~/.chatgpt2localbridge/
├── .env.local           local secrets and runtime settings (mode 0600)
├── bridge.policy.json   approved roots and deny rules
├── logs/
└── repositories/        manifests, symbols, chunks, and scan state
```

Verify the running service:

```bash
curl --fail http://127.0.0.1:3838/health
open http://127.0.0.1:3838/app
```

To run in the foreground instead of installing launchd:

```bash
node dist/index.js start
```

An install without cloning is also supported:

```bash
npx github:ZhWang1104/chatgpt2localbridge setup --root ~/Projects/my-repo
npx github:ZhWang1104/chatgpt2localbridge start
```

## ChatGPT Custom Connector

A hosted ChatGPT connector needs a stable HTTPS URL. The recommended setup is a
Cloudflare named tunnel on a domain in your Cloudflare account:

```bash
cloudflared tunnel login
node dist/index.js install-tunnel --hostname bridge.example.com
```

Create the connector where Custom Connectors are available:

| Field | Value |
| --- | --- |
| Name | `ChatGPT2LocalBridge` |
| URL | `https://bridge.example.com/mcp` |
| Authentication | OAuth |

When the local authorization page opens, enter the unlock code stored in
`~/.chatgpt2localbridge/.env.local`. Never paste that code, OAuth tokens, tunnel
credentials, or the environment file into a chat, issue, screenshot, or commit.

For Linux hosts, use the [Linux deployment guide](./docs/linux-deploy.md) or:

```bash
curl -fsSL https://raw.githubusercontent.com/ZhWang1104/chatgpt2localbridge/main/scripts/linux-one-click-install.sh | bash
```

## Large Repository Workflow

The bridge does not claim that one model context can retain an entire large
repository. Instead, it makes completeness measurable and reading resumable.

```text
repo_open(projectPath)
repo_map(snapshotId) until the manifest is fully paged
repo_context(snapshotId, task) for task-focused orientation
repo_scan(action=start, snapshotId)

repeat:
  repo_scan(action=next, scanId)
  read and summarize the returned chunks
  repo_scan(action=ack, scanId, chunkIds, summaries)

repo_coverage(snapshotId, scanId)
```

A full-read claim is valid only when:

- `trackedFiles == accountedFiles`
- every text chunk has been delivered and acknowledged
- `failedChunks == 0`
- AST failures are empty for supported languages
- unsupported, binary, denied, and missing files remain explicitly visible

CodeGraph is a relationship layer, not the completeness metric. Raw Git
inventory and source chunks remain authoritative even when CodeGraph is absent
or covers fewer files.

### Multiple Branches

Use one stable Git worktree per branch and call `repo_open` for each worktree.
Snapshots include branch, commit, dirty state, and content hashes. `repo_read`
rejects stale snapshots after files change, while `repo_compare` compares two
refs without checking out either branch.

See [Large Repository Workflow](./docs/large-repositories.md) for the full
coverage contract.

## Repository Tools

| Tool | Purpose |
| --- | --- |
| `repo_open` | Build a branch-bound manifest, chunks, and optional symbols |
| `repo_map` | Page through every accounted tracked file |
| `repo_read` | Read an immutable chunk or bounded line range |
| `repo_search` | Search raw repository text with exact paths and lines |
| `repo_symbols` | Build or search AST definitions and references |
| `repo_context` | Combine raw search, AST symbols, and fresh CodeGraph context |
| `repo_compare` | Compare commits or branches without changing the worktree |
| `repo_scan` | Start, continue, acknowledge, and resume a full scan |
| `repo_coverage` | Report file, line, chunk, delivery, and failure coverage |

Other tool families cover bounded file access, project bundles, Git diffs,
skills, handoffs, Codex Runner tasks, tests, traces, and local diagnostics. The
generated catalog is available in [`assets/mcp-tools.json`](./assets/mcp-tools.json).

## Tool Profiles

| Profile | Use |
| --- | --- |
| `readonly` | Recommended public connector profile for repository analysis |
| `minimal` / `chatgpt-app` | Legacy bounded app and write workflows |
| `standard` / `normal` | Project, Git, tests, skills, traces, and Codex tasks |
| `full` / `debug` | Trusted local debugging with low-level file, process, and shell tools |
| `codex-runner-only` | High-level Codex task control without general project tools |

`setup` selects `readonly`. Do not enable `standard` or `full` on a public
connector unless local writes and command execution are intentionally required.

## Security Model

- Startup fails if the policy is missing, malformed, or invalid.
- All paths are resolved canonically and must remain inside an approved root.
- Traversal and existing or dangling symlink escapes are rejected.
- Deny globs apply to reads, listings, search, manifests, symbols, and scans.
- HTTP binds to `127.0.0.1`; the tunnel is a separate explicit boundary.
- Browser CORS is restricted to configured origins.
- Shell execution is disabled by default.
- The default OAuth scope is `workspace:read`.
- Runtime secrets stay in `.env.local`, which is excluded from Git and written
  with owner-only permissions.

Review [`bridge.policy.example.json`](./bridge.policy.example.json) and the
[security model](./docs/security.md) before expanding roots or enabling writes.

## CLI

| Command | Purpose |
| --- | --- |
| `setup --root <path>` | Create fail-closed configuration and local secrets |
| `start` | Run the OAuth/MCP HTTP service in the foreground |
| `doctor [--json]` | Check configuration, dependencies, roots, and health |
| `status [--json]` | Show local configuration and service status |
| `index [--root <path>] [--json]` | Build Git manifest, AST symbols, and sync CodeGraph |
| `install-service` | Install and start the macOS launchd service |
| `install-tunnel --hostname <host>` | Create a fixed Cloudflare tunnel and launchd service |
| `stop` / `restart` | Control the installed bridge service |

Run `node dist/index.js help` for the current command contract.

## macOS Application

```bash
npm run macos:app
open build/macos/ChatGPT2LocalBridge.app
```

Or install it into `/Applications`:

```bash
npm run macos:install
```

The application embeds Node, its non-system dynamic libraries, production
dependencies, and the same TypeScript engine used by the CLI. It provides a
local console for service status, policy, logs, tool activity, and connector
operations.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run tools:catalog
npm pack --dry-run
```

Build the macOS application with `npm run macos:app`. The complete test suite
covers MCP profiles, OAuth metadata, CORS, policy failures, denied paths,
symlink escapes, CLI setup, branch isolation, UTF-8 chunking, symbols, and
resumable scans.

## Documentation

- [Architecture](./docs/architecture.md)
- [Large repository workflow](./docs/large-repositories.md)
- [Operations](./docs/operations.md)
- [Security model](./docs/security.md)
- [Authentication modes](./docs/authentication-modes.md)
- [Linux deployment](./docs/linux-deploy.md)
- [Canonical runtime and coverage ADR](./docs/decisions/001-canonical-runtime-and-repository-coverage.md)
- [Roadmap](./ROADMAP.md)

## Limits And Non-Goals

- This project does not automate or scrape the ChatGPT website. It uses MCP and
  ChatGPT Custom Connectors.
- It does not upload a repository automatically. Content leaves the machine
  only in tool responses requested by the authorized client.
- A scan proves accountable delivery, not permanent model memory. Summaries and
  task-specific retrieval are still necessary for large systems.
- AST symbol coverage currently targets TypeScript, JavaScript, and Python.
  Other text files remain searchable and chunk-readable.
- CodeGraph follows a concrete worktree. Use separate worktrees for simultaneous
  branch indexes.

## Upstream And License

- Original project and author:
  [`Harzva/chatgpt2localbridge`](https://github.com/Harzva/chatgpt2localbridge)
- Enhanced fork:
  [`ZhWang1104/chatgpt2localbridge`](https://github.com/ZhWang1104/chatgpt2localbridge)
- License: [MIT](./LICENSE)

Contributions should preserve upstream attribution and keep the default public
connector surface narrow, read-only, and auditable.
