import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface BridgePolicy {
  allowedProjectRoots: string[];
  skillRoots: string[];
  denyGlobs: string[];
  shell: {
    enabled: boolean;
    denyPatterns: string[];
  };
}

export type BridgeToolProfile = 'normal' | 'debug' | 'codex-runner-only' | 'chatgpt-app' | 'readonly';

export interface BridgeConfig {
  /** Where to store run data on disk */
  dataDir: string;
  /** Where launchd/stdout logs are written */
  logDir: string;
  /** Optional bearer/header token for HTTP MCP requests */
  authToken?: string;
  /** Allow MCP URL query token auth for clients that cannot send headers */
  allowUrlTokenAuth: boolean;
  /** Browser origins allowed to make credentialed HTTP requests. */
  http: {
    allowedOrigins: string[];
  };
  /** OAuth settings for hosted MCP clients such as ChatGPT connectors */
  oauth: {
    enabled: boolean;
    publicBaseUrl?: string;
    unlockCode?: string;
    tokenTtlSeconds: number;
    codeTtlSeconds: number;
    scopes: string[];
  };
  /** Local browser console for operators */
  dashboard: {
    token?: string;
  };
  /** Policy controlling filesystem and shell boundaries */
  policyPath: string;
  policy: BridgePolicy;
  /** Controls which MCP tools are exposed to hosted clients */
  toolProfile: BridgeToolProfile;
  /** Optional provider settings for Codex Runner */
  codexProvider: CodexProviderConfig;
}

export type CodexProviderKind = 'official' | 'openai-compatible' | 'sub2api';

export interface CodexProviderConfig {
  kind: CodexProviderKind;
  profile?: string;
  codexHome?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
}

export function loadConfig(): BridgeConfig {
  const bootstrapDataDir = env('DATA_DIR')
    ?? path.join(os.homedir(), '.chatgpt2localbridge');
  loadLocalEnv(env('CONFIG_ENV') ?? path.join(bootstrapDataDir, '.env.local'));
  const dataDir = env('DATA_DIR') ?? bootstrapDataDir;
  const logDir = env('LOG_DIR')
    ?? path.join(dataDir, 'logs');
  const authToken = env('AUTH_TOKEN') || undefined;
  const allowUrlTokenAuth = env('ALLOW_URL_TOKEN') === '1'
    || env('ALLOW_URL_TOKEN') === 'true';
  const allowedOrigins = (env('ALLOWED_ORIGINS') ?? 'https://chatgpt.com')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const oauthScopes = (env('OAUTH_SCOPES')
    ?? 'workspace:read')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const oauth = {
    enabled: env('OAUTH_ENABLED') === '1'
      || env('OAUTH_ENABLED') === 'true',
    publicBaseUrl: env('PUBLIC_BASE_URL') || undefined,
    unlockCode: env('OAUTH_UNLOCK_CODE') || undefined,
    tokenTtlSeconds: parsePositiveInt(env('OAUTH_TOKEN_TTL_SECONDS'), 7 * 24 * 60 * 60),
    codeTtlSeconds: parsePositiveInt(env('OAUTH_CODE_TTL_SECONDS'), 10 * 60),
    scopes: oauthScopes.length > 0 ? oauthScopes : ['workspace:read'],
  };
  const dashboard = {
    token: env('DASHBOARD_TOKEN') || undefined,
  };
  const policyPath = resolvePolicyPath(env('POLICY_PATH'), dataDir);
  const policy = loadPolicy(policyPath);
  const toolProfile = parseToolProfile(env('TOOL_PROFILE'));
  const codexProvider = loadCodexProvider();

  return {
    dataDir,
    logDir,
    authToken,
    allowUrlTokenAuth,
    http: { allowedOrigins },
    oauth,
    dashboard,
    policyPath,
    policy,
    toolProfile,
    codexProvider,
  };
}

function env(name: string): string | undefined {
  return process.env[`LOCALBRIDGE_${name}`];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseToolProfile(value: string | undefined): BridgeToolProfile {
  const normalized = (value ?? 'readonly').trim().toLowerCase();
  switch (normalized) {
    case 'read-only':
    case 'readonly':
      return 'readonly';
    case 'full':
    case 'debug':
    case 'all':
      return 'debug';
    case 'minimal':
    case 'public':
    case 'connector':
    case 'connector-minimal':
      return 'chatgpt-app';
    case 'codex':
    case 'codex-runner':
    case 'codex-runner-only':
    case 'codexrunner':
      return 'codex-runner-only';
    case 'chatgpt':
    case 'chatgpt-app':
    case 'app':
      return 'chatgpt-app';
    case 'standard':
    case 'normal':
    default:
      return 'normal';
  }
}

function loadCodexProvider(): CodexProviderConfig {
  const rawKind = (env('CODEX_PROVIDER') ?? 'official').trim().toLowerCase();
  const kind: CodexProviderKind = rawKind === 'sub2api'
    ? 'sub2api'
    : rawKind === 'openai-compatible' || rawKind === 'openai_compatible' || rawKind === 'compatible'
      ? 'openai-compatible'
      : 'official';
  const apiKeyEnv = env('CODEX_API_KEY_ENV')?.trim() || 'OPENAI_API_KEY';
  return {
    kind,
    profile: env('CODEX_PROFILE') || undefined,
    codexHome: env('CODEX_HOME') ? path.resolve(expandHome(env('CODEX_HOME') ?? '')) : undefined,
    model: env('CODEX_MODEL') || undefined,
    baseUrl: env('CODEX_BASE_URL') || env('OPENAI_BASE_URL') || undefined,
    apiKeyEnv,
  };
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function resolvePolicyPath(policyPath: string | undefined, dataDir: string): string {
  return policyPath ? path.resolve(expandHome(policyPath)) : path.join(dataDir, 'bridge.policy.json');
}

function loadLocalEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!/^LOCALBRIDGE_[A-Z0-9_]+$/.test(key) || process.env[key] !== undefined) continue;
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadPolicy(policyPath: string): BridgePolicy {
  if (!fs.existsSync(policyPath)) {
    throw new Error(`Policy file does not exist: ${policyPath}. Run \`chatgpt2localbridge setup --root <workspace>\` first.`);
  }

  const defaultSkillRoot = path.join(os.homedir(), '.codex', 'skills');
  const safeDefaults = {
    skillRoots: fs.existsSync(defaultSkillRoot) ? [defaultSkillRoot] : [],
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
  } satisfies Omit<BridgePolicy, 'allowedProjectRoots'>;

  try {
    const raw = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as Partial<BridgePolicy>;
    if (!Array.isArray(raw.allowedProjectRoots) || raw.allowedProjectRoots.length === 0) {
      throw new Error('allowedProjectRoots must contain at least one workspace root');
    }
    if (raw.allowedProjectRoots.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error('allowedProjectRoots must only contain non-empty strings');
    }
    const skillRoots = readStringArray('skillRoots', raw.skillRoots, safeDefaults.skillRoots);
    const denyGlobs = readStringArray('denyGlobs', raw.denyGlobs, safeDefaults.denyGlobs);
    const shellEnabled = (raw.shell as { enabled?: unknown } | undefined)?.enabled;
    if (shellEnabled !== undefined && typeof shellEnabled !== 'boolean') {
      throw new Error('shell.enabled must be a boolean');
    }
    const denyPatterns = readStringArray('shell.denyPatterns', raw.shell?.denyPatterns, safeDefaults.shell.denyPatterns);
    return {
      allowedProjectRoots: raw.allowedProjectRoots.map((entry) => path.resolve(expandHome(entry))),
      skillRoots,
      denyGlobs,
      shell: {
        enabled: shellEnabled ?? safeDefaults.shell.enabled,
        denyPatterns,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load policy ${policyPath}: ${message}`);
  }
}

function readStringArray(name: string, value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${name} must only contain non-empty strings`);
  }
  return value as string[];
}
