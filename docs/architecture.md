# Architecture

```text
ChatGPT
  -> OAuth Custom Connector
  -> HTTPS tunnel
  -> localhost:3838
  -> ChatGPT2LocalBridge
  -> local policy
  -> approved workspace roots
```

The CLI, launchd service, and macOS app all run the same TypeScript engine on
loopback. The app bundle includes Node and production dependencies.

## Components

- MCP server: defaults to the read-only `repo_*` repository workflow; broader
  file, shell, task, and process tools require an explicit profile.
- HTTP transport: exposes `/mcp` for hosted clients.
- OAuth server: exposes discovery metadata, DCR, authorize, and token endpoints.
- Policy: decides which local paths and shell operations are allowed.
- Tunnel: optional public HTTPS route, commonly ngrok or a secure tunnel service.
- Repository coverage: Git manifest, text chunks, AST symbols, optional
  CodeGraph relationships, and persistent scan acknowledgements.

## Why OAuth

OAuth lets ChatGPT register a client, redirect through an authorization page, exchange an authorization code for a bearer token, and then call `/mcp` with that token. This avoids copying static tokens into the ChatGPT connector UI.
