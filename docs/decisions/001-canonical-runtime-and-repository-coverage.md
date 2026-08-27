# ADR-001: Canonical TypeScript Runtime And Layered Repository Coverage

## Status

Accepted

## Date

2026-08-27

## Context

The project previously exposed a full TypeScript OAuth/MCP server and a smaller
Rust preview through different entry points. Large repositories also lacked a
way to prove that every tracked file and text line had been accounted for.
CodeGraph improves relationships but intentionally indexes only supported code,
so its file count cannot prove repository completeness.

## Decision

Use the TypeScript server as the single production engine for CLI, launchd, and
the macOS app. Use a layered repository model:

- Git manifest for complete tracked-file accounting;
- hash-bound line/byte chunks for raw text delivery;
- TypeScript/JavaScript/Python AST indexes for identifiers;
- CodeGraph for relationships and impact;
- persistent scan acknowledgement and summaries for cross-conversation state.

Default policy loading is fail-closed and the default MCP profile is read-only.

## Alternatives Considered

- Treat the Rust preview as a second production engine: rejected because its
  OAuth and tool contracts do not match the TypeScript engine.
- Treat CodeGraph as the complete repository index: rejected because unsupported,
  generated, binary, denied, and non-code files are intentionally absent.
- Upload the full repository in one response: rejected because model context and
  MCP response limits make it neither reliable nor resumable.

## Consequences

The macOS bundle is larger because it includes Node and production dependencies.
Repository scans are multi-call operations, but progress is measurable,
branch-isolated, resumable, and auditable.
