#!/usr/bin/env bash
set -euo pipefail

TUNNEL_NAME="chatgpt2localbridge"
HOSTNAME=""
PORT="3838"
CONFIG_DIR="${LOCALBRIDGE_CONFIG_DIR:-$HOME/.chatgpt2localbridge}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) HOSTNAME="${2:-}"; shift 2 ;;
    --name) TUNNEL_NAME="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --config-dir) CONFIG_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: install-cloudflare-tunnel.sh --hostname bridge.example.com [--name chatgpt2localbridge] [--port 3838]" >&2
  exit 2
fi
if [[ ! "$HOSTNAME" =~ ^[A-Za-z0-9.-]+$ || "$HOSTNAME" != *.* ]]; then
  echo "Invalid hostname: $HOSTNAME" >&2
  exit 2
fi
if [[ ! "$TUNNEL_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid tunnel name: $TUNNEL_NAME" >&2
  exit 2
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

CLOUDFLARED_BIN="$(command -v cloudflared)"
if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "Cloudflare account authorization is required once. Run: cloudflared tunnel login" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR/logs" "$HOME/Library/LaunchAgents"
TUNNEL_ID="$($CLOUDFLARED_BIN tunnel list --output json | node -e '
const fs = require("node:fs");
const name = process.argv[1];
const tunnels = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(tunnels.find((item) => item.name === name)?.id ?? "");
' "$TUNNEL_NAME")"

if [[ -z "$TUNNEL_ID" ]]; then
  "$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$($CLOUDFLARED_BIN tunnel list --output json | node -e '
const fs = require("node:fs");
const name = process.argv[1];
const tunnels = JSON.parse(fs.readFileSync(0, "utf8"));
const id = tunnels.find((item) => item.name === name)?.id;
if (!id) process.exit(1);
process.stdout.write(id);
' "$TUNNEL_NAME")"
fi

CREDENTIALS_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
if [[ ! -f "$CREDENTIALS_FILE" ]]; then
  echo "Tunnel credentials file is missing: $CREDENTIALS_FILE" >&2
  exit 1
fi

TUNNEL_CONFIG="$CONFIG_DIR/cloudflared.yml"
cat >"$TUNNEL_CONFIG" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YAML
chmod 600 "$TUNNEL_CONFIG"

"$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

ENV_FILE="$CONFIG_DIR/.env.local"
node - "$ENV_FILE" "https://$HOSTNAME" <<'NODE'
const fs = require('node:fs');
const [file, publicUrl] = process.argv.slice(2);
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
const keys = new Set(['LOCALBRIDGE_PUBLIC_BASE_URL', 'LOCALBRIDGE_OAUTH_ENABLED']);
const kept = existing.filter((line) => {
  const normalized = line.trim().replace(/^export\s+/, '');
  return ![...keys].some((key) => normalized.startsWith(`${key}=`));
});
kept.push(`export LOCALBRIDGE_PUBLIC_BASE_URL="${publicUrl}"`);
kept.push('export LOCALBRIDGE_OAUTH_ENABLED=1', '');
fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
NODE
chmod 600 "$ENV_FILE"

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

LABEL="com.chatgpt2localbridge.cloudflared"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLOUDFLARED_XML="$(escape_xml "$CLOUDFLARED_BIN")"
CONFIG_XML="$(escape_xml "$TUNNEL_CONFIG")"
LOG_XML="$(escape_xml "$CONFIG_DIR/logs/cloudflared.log")"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$CLOUDFLARED_XML</string><string>--config</string><string>$CONFIG_XML</string><string>tunnel</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
</dict></plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed fixed Cloudflare Tunnel: https://$HOSTNAME"
echo "Connector URL: https://$HOSTNAME/mcp"
