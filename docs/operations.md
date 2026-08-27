# Operations

## Local Run

```bash
npm run build
node dist/index.js setup --root ~/Projects
node dist/index.js doctor
node dist/index.js start
```

## Install As A Mac LaunchAgent

```bash
node dist/index.js setup --root ~/Projects
node dist/index.js install-service
```

If port 3838 is already used, change `LOCALBRIDGE_PORT` and
`LOCALBRIDGE_PUBLIC_BASE_URL` in `.env.local`, then run the installer again.

Stop it with:

```bash
node dist/index.js stop
node dist/index.js restart
```

Install a fixed Cloudflare named tunnel after `cloudflared tunnel login`:

```bash
node dist/index.js install-tunnel --hostname bridge.example.com
node dist/index.js restart
```

The generated service and tunnel configuration live under
`~/.chatgpt2localbridge`; both launchd jobs start after login.

## Health

```bash
curl -sS http://127.0.0.1:3838/health
```

## Local Console

```bash
open http://127.0.0.1:3838/app
```

The console APIs require `LOCALBRIDGE_DASHBOARD_TOKEN`.

```bash
curl -sS -H "x-localbridge-dashboard-token: $LOCALBRIDGE_DASHBOARD_TOKEN" \
  http://127.0.0.1:3838/app/api/activity
```

## OAuth Discovery

```bash
curl -sS "$LOCALBRIDGE_PUBLIC_BASE_URL/.well-known/oauth-protected-resource/mcp"
curl -sS "$LOCALBRIDGE_PUBLIC_BASE_URL/.well-known/oauth-authorization-server"
```

## Common 401 Causes

- ChatGPT selected an old connector.
- OAuth was not enabled in the running service.
- `LOCALBRIDGE_PUBLIC_BASE_URL` does not match the URL configured in ChatGPT.
- The token expired.
- The connector was created before OAuth metadata was fixed.
