#!/usr/bin/env node

import { loadConfig } from './config.js';
import { startStdioServer } from './mcpServer.js';
import { startHttpServer } from './httpServer.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RepoStore } from './repoIndex.js';
import { SymbolStore } from './symbolIndex.js';

// ── CLI Bridge Entry Point ──────────────────────────────────────────────────
//
// Transport modes:
//   stdio  (default)  — for ChatGPT Desktop / local MCP clients
//   http               — for hosted ChatGPT MCP connectors via a tunnel
//
// Usage:
//   node dist/index.js                 → stdio mode
//   node dist/index.js --http 3838     → MCP HTTP mode on port 3838
//   LOCALBRIDGE_PORT=3838 node dist/index.js --http  → MCP HTTP via env

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args[0] === 'help') {
    printHelp();
    return;
  }
  if (args[0] === 'init' || args[0] === 'setup') {
    setupProject(args.slice(1));
    return;
  }
  if (args[0] === 'doctor' || args[0] === 'status') {
    await doctor(args.slice(1), args[0] === 'status');
    return;
  }
  if (args[0] === 'index') {
    indexRepository(args.slice(1));
    return;
  }
  if (['install-service', 'stop', 'restart'].includes(args[0] ?? '')) {
    manageService(args[0]);
    return;
  }
  if (args[0] === 'install-tunnel') {
    runBundledScript('install-cloudflare-tunnel.sh', args.slice(1));
    return;
  }

  const config = loadConfig();
  const envPort = process.env.LOCALBRIDGE_PORT;
  const httpMode = args[0] === 'start' || args.includes('--http') || args.includes('-h') || !!envPort;
  let httpPort = 3838;

  const httpIdx = args.indexOf('--http');
  if (httpIdx !== -1 && args[httpIdx + 1]) {
    httpPort = parseInt(args[httpIdx + 1], 10);
  } else if (envPort) {
    httpPort = parseInt(envPort, 10);
  }

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error(`[bridge] Received ${signal}, shutting down...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.error(`[bridge] ChatGPT2LocalBridge v0.1.1 starting`);
  console.error(`[bridge] Data dir: ${config.dataDir}`);
  if (httpMode) console.error(`[bridge] Local console: http://127.0.0.1:${httpPort}/app`);

  if (httpMode) {
    console.error(`[bridge] Mode: MCP Streamable HTTP`);
    await startHttpServer({ config }, httpPort);
  } else {
    console.error(`[bridge] Mode: MCP stdio`);
    console.error(`[bridge] Waiting for MCP client connection...`);
    await startStdioServer(config);
  }
}

function printHelp(): void {
  console.log(`ChatGPT2LocalBridge

Usage:
  chatgpt2localbridge setup --root <workspace-root> [--public-url <https-url>] [--port 3838]
  chatgpt2localbridge start
  chatgpt2localbridge status [--json]
  chatgpt2localbridge doctor [--json]
  chatgpt2localbridge index [--root <workspace>] [--no-codegraph] [--json]
  chatgpt2localbridge install-service
  chatgpt2localbridge install-tunnel --hostname bridge.example.com
  chatgpt2localbridge stop|restart
  chatgpt2localbridge --http 3838
  chatgpt2localbridge

Commands:
  setup      Create a fail-closed policy and config in ~/.chatgpt2localbridge.
  init       Alias for setup.
  start      Start the full OAuth/MCP HTTP service in the foreground.
  status     Show local configuration and service status.
  doctor     Check configuration, tools, workspace roots, and service health.
  index      Build Git manifest and AST symbols; sync an existing CodeGraph index.
  install-service  Install and start the macOS launchd service.
  install-tunnel   Create a fixed Cloudflare named tunnel and launchd service.
  stop       Stop the installed macOS service.
  restart    Restart the installed macOS service.

Options:
  --http     Start MCP Streamable HTTP server on a port. Default: 3838.
  --port     Port written during init. Default: 3838.
  --help     Show this help.

Examples:
  npx github:harzva/chatgpt2localbridge setup --root ~/Projects
  npx github:harzva/chatgpt2localbridge start
`);
}

function setupProject(args: string[]): void {
  const rootArg = optionValue(args, '--root') ?? process.cwd();
  const publicUrlArg = optionValue(args, '--public-url');
  const publicUrl = publicUrlArg ? normalizePublicUrl(publicUrlArg) : '';
  const port = optionValue(args, '--port') ?? '3838';
  const force = args.includes('--force');
  const requestedWorkspaceRoot = path.resolve(expandHome(rootArg));
  const dataDir = path.resolve(expandHome(optionValue(args, '--config-dir') ?? path.join(os.homedir(), '.chatgpt2localbridge')));
  const policyPath = path.join(dataDir, 'bridge.policy.json');
  const envPath = path.join(dataDir, '.env.local');
  const unlockCode = randomBytes(24).toString('hex');
  const dashboardToken = randomBytes(24).toString('hex');
  const codegraph = spawnSync('/usr/bin/env', ['which', 'codegraph'], { encoding: 'utf8' });
  const codegraphBin = codegraph.status === 0 ? codegraph.stdout.trim() : '';

  if (!fs.existsSync(requestedWorkspaceRoot)) {
    throw new Error(`Workspace root does not exist: ${requestedWorkspaceRoot}`);
  }
  const workspaceRoot = fs.realpathSync.native(requestedWorkspaceRoot);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  writeIfMissing(policyPath, JSON.stringify({
    allowedProjectRoots: [workspaceRoot],
    skillRoots: [path.join(os.homedir(), '.codex', 'skills')],
    denyGlobs: [
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/*.p12',
      '**/*.pfx',
      '**/.npmrc',
      '**/.netrc',
      '**/.ssh/**',
      '**/id_rsa',
      '**/id_ed25519',
    ],
    shell: {
      enabled: false,
      denyPatterns: [
        'sudo',
        'rm\\s+-rf\\s+/',
        'chmod\\s+-R',
        'chown\\s+-R',
        'security\\s+find-',
        'launchctl\\s+bootout\\s+system',
      ],
    },
  }, null, 2) + '\n', force);

  writeIfMissing(envPath, [
    `export LOCALBRIDGE_PORT=${port}`,
    `export LOCALBRIDGE_DATA_DIR="${dataDir}"`,
    `export LOCALBRIDGE_LOG_DIR="${path.join(dataDir, 'logs')}"`,
    `export LOCALBRIDGE_POLICY_PATH="${policyPath}"`,
    `export LOCALBRIDGE_OAUTH_ENABLED=${publicUrl ? '1' : '0'}`,
    ...(publicUrl ? [`export LOCALBRIDGE_PUBLIC_BASE_URL="${publicUrl}"`] : []),
    `export LOCALBRIDGE_OAUTH_UNLOCK_CODE="${unlockCode}"`,
    `export LOCALBRIDGE_DASHBOARD_TOKEN="${dashboardToken}"`,
    'export LOCALBRIDGE_ALLOW_URL_TOKEN=0',
    'export LOCALBRIDGE_ALLOWED_ORIGINS="https://chatgpt.com"',
    'export LOCALBRIDGE_TOOL_PROFILE=readonly',
    'export LOCALBRIDGE_OAUTH_SCOPES="workspace:read"',
    ...(codegraphBin ? [`export LOCALBRIDGE_CODEGRAPH_BIN="${codegraphBin}"`] : []),
    '',
  ].join('\n'), force);

  console.log('Configured ChatGPT2LocalBridge.');
  console.log(`Policy: ${policyPath}`);
  console.log(`Env:    ${envPath} (contains your local unlock code; do not commit)`);
  console.log('Run:    chatgpt2localbridge start');
  console.log(`App:    http://127.0.0.1:${port}/app`);
  if (publicUrl) printConnectorSummary({ publicUrl, port, workspaceRoot, envPath });
}

function manageService(command: string): void {
  if (process.platform !== 'darwin') throw new Error(`${command} currently requires macOS launchd`);
  const label = 'com.chatgpt2localbridge.bridge';
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (command === 'install-service') {
    runBundledScript('install-launchd.sh', []);
    return;
  }
  const args = command === 'stop'
    ? ['bootout', domain, path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)]
    : ['kickstart', '-k', `${domain}/${label}`];
  const result = spawnSync('launchctl', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}`);
}

function runBundledScript(name: string, args: string[]): void {
  const script = path.resolve(path.dirname(process.argv[1]), '..', 'scripts', name);
  const result = spawnSync('/bin/bash', [script, ...args], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status ?? 'unknown'}`);
}

async function doctor(args: string[], statusOnly: boolean): Promise<void> {
  applyConfigDirArg(args);

  const report: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const config = loadConfig();
    report.config = { ok: true, detail: `dataDir=${config.dataDir}; profile=${config.toolProfile}` };
    report.policy = { ok: true, detail: config.policyPath };
    const missingRoots = config.policy.allowedProjectRoots.filter((root) => !fs.existsSync(root));
    report.workspaceRoots = missingRoots.length
      ? { ok: false, detail: `missing: ${missingRoots.join(', ')}` }
      : { ok: true, detail: config.policy.allowedProjectRoots.join(', ') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.config = { ok: false, detail };
    report.policy = { ok: false, detail };
    report.workspaceRoots = { ok: false, detail: 'configuration unavailable' };
  }

  const port = process.env.LOCALBRIDGE_PORT ?? '3838';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) });
    report.service = { ok: response.ok, detail: response.ok ? `http://127.0.0.1:${port}` : `HTTP ${response.status}` };
  } catch {
    report.service = { ok: false, detail: `offline at http://127.0.0.1:${port}` };
  }

  if (!statusOnly) {
    for (const command of ['node', 'git', 'rg', 'codegraph', 'cloudflared']) {
      const found = spawnSync('/usr/bin/env', ['which', command], { encoding: 'utf8' });
      report[command] = {
        ok: found.status === 0,
        detail: found.status === 0 ? found.stdout.trim() : 'not installed (optional unless used)',
      };
    }
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const [name, result] of Object.entries(report)) {
    console.log(`${result.ok ? 'OK' : 'WARN'} ${name}: ${result.detail}`);
  }
}

function indexRepository(args: string[]): void {
  applyConfigDirArg(args);
  const config = loadConfig();
  const projectPath = optionValue(args, '--root') ?? config.policy.allowedProjectRoots[0];
  if (!projectPath) throw new Error('index requires --root or one configured allowedProjectRoot');
  const manifest = new RepoStore({ dataDir: config.dataDir, policy: config.policy }).open(projectPath);
  const symbolIndex = new SymbolStore({ dataDir: config.dataDir, policy: config.policy }).index(manifest.snapshotId);
  const repository = {
    snapshotId: manifest.snapshotId,
    projectPath: manifest.projectPath,
    branch: manifest.branch,
    headCommit: manifest.headCommit,
    dirty: manifest.dirty,
    trackedFiles: manifest.trackedFiles,
    accountedFiles: manifest.files.length,
    indexedTextFiles: manifest.textFiles,
    indexedLines: manifest.textLines,
    chunks: manifest.chunks.length,
  };
  const symbols = {
    status: symbolIndex.failures.length ? 'partial' : 'complete',
    supportedFiles: symbolIndex.supportedFiles,
    unsupportedFiles: symbolIndex.unsupportedFiles,
    symbols: symbolIndex.symbols.length,
    failures: symbolIndex.failures,
  };
  let codegraph: Record<string, unknown> = { status: 'not_requested' };
  if (!args.includes('--no-codegraph')) {
    const configured = process.env.LOCALBRIDGE_CODEGRAPH_BIN;
    const discovered = configured ? undefined : spawnSync('/usr/bin/env', ['which', 'codegraph'], { encoding: 'utf8' });
    const executable = configured || (discovered?.status === 0 ? discovered.stdout.trim() : '');
    if (!executable) {
      codegraph = { status: 'unavailable' };
    } else if (!fs.existsSync(path.join(manifest.projectPath, '.codegraph'))) {
      codegraph = { status: 'not_initialized', executable };
    } else {
      const synced = spawnSync(executable, ['sync', manifest.projectPath], { encoding: 'utf8', timeout: 120_000 });
      codegraph = synced.status === 0
        ? { status: 'synced', executable, output: synced.stdout.trim().slice(0, 4000) }
        : { status: 'failed', executable, error: synced.stderr.trim().slice(0, 4000) };
    }
  }
  const report = { repository, symbols, codegraph };
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : [
    `Repository: ${repository.projectPath}`,
    `Snapshot: ${repository.snapshotId} (${repository.branch})`,
    `Coverage: ${repository.accountedFiles}/${repository.trackedFiles} files; ${repository.indexedLines} lines; ${repository.chunks} chunks`,
    `Symbols: ${symbols.status}; ${symbols.symbols} records; ${symbols.failures.length} failures`,
    `CodeGraph: ${String(codegraph.status)}`,
  ].join('\n'));
}

function applyConfigDirArg(args: string[]): void {
  const configDir = optionValue(args, '--config-dir');
  if (!configDir) return;
  const resolved = path.resolve(expandHome(configDir));
  process.env.LOCALBRIDGE_DATA_DIR = resolved;
  process.env.LOCALBRIDGE_CONFIG_ENV = path.join(resolved, '.env.local');
  process.env.LOCALBRIDGE_POLICY_PATH = path.join(resolved, 'bridge.policy.json');
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizePublicUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function printConnectorSummary(options: {
  publicUrl: string;
  port: string;
  workspaceRoot: string;
  envPath: string;
}): void {
  const { publicUrl, port, workspaceRoot, envPath } = options;
  console.log(`
Tunnel choices:
  ngrok:
    Register: https://dashboard.ngrok.com/signup
    Use when you want the fastest fixed development domain.
    Requires NGROK_AUTHTOKEN; set NGROK_DOMAIN for a stable Connector URL.

  Cloudflare Tunnel:
    Register: https://dash.cloudflare.com/sign-up
    Quick Tunnel is good for smoke tests, but the trycloudflare URL can change.
    Use a named tunnel for stable production URLs.

ChatGPT Connector fields:
  Name: ChatGPT2LocalBridge Linux
  Server URL: ${publicUrl}/mcp
  Authentication: OAuth

Advanced OAuth fields:
  Auth URL: ${publicUrl}/oauth/authorize
  Token URL: ${publicUrl}/oauth/token
  Registration URL: ${publicUrl}/oauth/register
  Authorization server base: ${publicUrl}
  Resource: ${publicUrl}/mcp
  Scopes: workspace:read
  OIDC: off

Authorization page:
  Bridge unlock code: read LOCALBRIDGE_OAUTH_UNLOCK_CODE from ${envPath} on this host.
  Do not paste unlock codes, tokens, cookies, or .env contents into public chats, issues, screenshots, or commits.

Local checks:
  curl -sS http://127.0.0.1:${port}/health
  http://127.0.0.1:${port}/app

Agent setup prompt:
  Configure ChatGPT2LocalBridge from https://github.com/Harzva/chatgpt2localbridge on this Linux host.
  Keep secrets local. Do not print .env.local, OAuth tokens, ngrok authtokens, cookies, or unlock codes.
  Use workspace root ${workspaceRoot}. Keep allowed roots narrow.
  Verify /health, expose one HTTPS tunnel, set LOCALBRIDGE_PUBLIC_BASE_URL to the public https origin, then report the Connector fields and verification status only.
`);
}

function writeIfMissing(filePath: string, content: string, force: boolean): void {
  if (fs.existsSync(filePath) && !force) {
    console.log(`Exists, not overwritten: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, { mode: filePath.endsWith('.env.local') ? 0o600 : 0o644 });
  console.log(`Wrote: ${filePath}`);
}

main().catch((err) => {
  console.error('[bridge] Fatal error:', err);
  process.exit(1);
});
