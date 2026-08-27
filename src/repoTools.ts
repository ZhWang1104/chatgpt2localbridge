import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BridgeConfig } from './config.js';
import { RepoStore } from './repoIndex.js';
import { SymbolStore, type SymbolKind, type SymbolRole } from './symbolIndex.js';

type ToolWrapper = (name: string, handler: (args: any) => Promise<any>) => (args: any) => Promise<any>;

const resultOutput = { result: z.record(z.unknown()) };

export function registerRepoTools(server: McpServer, config: BridgeConfig, wrap: ToolWrapper): void {
  const store = new RepoStore({ dataDir: config.dataDir, policy: config.policy });
  const symbolStore = new SymbolStore({ dataDir: config.dataDir, policy: config.policy });

  register('repo_open', 'Open Repository Snapshot', 'Build a complete Git-tracked file manifest and line/byte chunk index for one branch or worktree.', {
    projectPath: z.string(),
    maxChunkLines: z.number().int().min(1).max(5000).default(400),
    maxChunkBytes: z.number().int().min(1024).max(500_000).default(96_000),
    indexSymbols: z.boolean().default(true),
  }, async ({ projectPath, maxChunkLines, maxChunkBytes, indexSymbols }) => {
    const manifest = store.open(projectPath, { maxChunkLines, maxChunkBytes });
    const symbols = indexSymbols ? symbolStore.index(manifest.snapshotId) : undefined;
    return {
      ...compactManifest(manifest),
      symbolIndex: symbols ? compactSymbolIndex(symbols) : { status: 'not_requested' },
    };
  });

  register('repo_map', 'Repository Map', 'Page through every accounted Git-tracked file in a repository snapshot. The cursor is bound to one immutable snapshot.', {
    snapshotId: z.string(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }, async ({ snapshotId, cursor, limit }) => {
    const manifest = store.loadManifest(snapshotId);
    const offset = decodeCursor(cursor, manifest.snapshotId);
    const files = manifest.files.slice(offset, offset + limit);
    const nextOffset = offset + files.length;
    return {
      ...compactManifest(manifest),
      files,
      cursor: nextOffset < manifest.files.length ? encodeCursor(manifest.snapshotId, nextOffset) : undefined,
      complete: nextOffset >= manifest.files.length,
    };
  });

  register('repo_read', 'Read Repository Content', 'Read an immutable indexed chunk or a bounded line range. Fails if the working tree changed after the snapshot.', {
    snapshotId: z.string(),
    chunkId: z.string().optional(),
    file: z.string().optional(),
    startLine: z.number().int().min(1).default(1),
    maxLines: z.number().int().min(1).max(5000).default(400),
  }, async ({ snapshotId, chunkId, file, startLine, maxLines }) => {
    if (chunkId) return store.readChunk(snapshotId, chunkId);
    if (!file) throw new Error('repo_read requires chunkId or file');
    return store.readLines(snapshotId, file, startLine, maxLines);
  });

  register('repo_coverage', 'Repository Coverage', 'Report accounted files, indexed lines, chunk delivery, acknowledgements, failures, and completion.', {
    snapshotId: z.string(),
    scanId: z.string().optional(),
  }, async ({ snapshotId, scanId }) => {
    let symbols: Record<string, unknown> = { status: 'not_indexed' };
    try { symbols = compactSymbolIndex(symbolStore.load(snapshotId)); } catch {}
    return { ...store.coverage(snapshotId, scanId), symbolIndex: symbols };
  });

  register('repo_symbols', 'Repository Symbols', 'Build or search the AST symbol index for TypeScript, JavaScript, and Python variables, parameters, properties, definitions, and references.', {
    action: z.enum(['index', 'search', 'status']).default('search'),
    snapshotId: z.string(),
    query: z.string().default(''),
    role: z.enum(['definition', 'reference']).optional(),
    kind: z.enum(['variable', 'parameter', 'property', 'function', 'class', 'interface', 'type', 'import', 'identifier']).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }, async ({ action, snapshotId, query, role, kind, limit }) => {
    if (action === 'index') return compactSymbolIndex(symbolStore.index(snapshotId));
    if (action === 'status') return compactSymbolIndex(symbolStore.load(snapshotId));
    if (!query) throw new Error('repo_symbols search requires query');
    return symbolStore.search(snapshotId, query, { role: role as SymbolRole | undefined, kind: kind as SymbolKind | undefined, limit });
  });

  register('repo_scan', 'Persistent Repository Scan', 'Start, continue, acknowledge, or inspect a resumable full-repository scan. Only acknowledged chunks count as read.', {
    action: z.enum(['start', 'next', 'ack', 'status']),
    snapshotId: z.string().optional(),
    scanId: z.string().optional(),
    chunkIds: z.array(z.string()).max(50).default([]),
    summaries: z.record(z.string().max(4000)).default({}),
    maxChunks: z.number().int().min(1).max(20).default(4),
    maxBytes: z.number().int().min(1024).max(1_000_000).default(300_000),
  }, async ({ action, snapshotId, scanId, chunkIds, summaries, maxChunks, maxBytes }) => {
    if (action === 'start') {
      if (!snapshotId) throw new Error('repo_scan start requires snapshotId');
      return store.scanStart(snapshotId);
    }
    if (!scanId) throw new Error(`repo_scan ${action} requires scanId`);
    if (action === 'next') return store.scanNext(scanId, { maxChunks, maxBytes });
    if (action === 'ack') return store.scanAck(scanId, chunkIds, summaries);
    return store.scanStatus(scanId);
  });

  register('repo_search', 'Search Repository', 'Search raw repository text while enforcing policy-denied paths. Results identify the current snapshot and exact lines.', {
    snapshotId: z.string(),
    query: z.string().min(1).max(1000),
    glob: z.string().optional(),
    maxResults: z.number().int().min(1).max(500).default(100),
  }, async ({ snapshotId, query, glob, maxResults }) => {
    const manifest = store.loadManifest(snapshotId);
    return searchRepository(config, manifest.projectPath, manifest.snapshotId, query, glob, maxResults);
  });

  register('repo_compare', 'Compare Repository Revisions', 'Compare two Git revisions or branches without changing the worktree.', {
    snapshotId: z.string(),
    base: z.string().min(1).max(240),
    head: z.string().min(1).max(240),
    maxBytes: z.number().int().min(1000).max(500_000).default(120_000),
  }, async ({ snapshotId, base, head, maxBytes }) => {
    const manifest = store.loadManifest(snapshotId);
    const baseCommit = resolveGitCommit(manifest.projectPath, base);
    const headCommit = resolveGitCommit(manifest.projectPath, head);
    const names = runGit(manifest.projectPath, ['diff', '--name-status', '--find-renames', baseCommit, headCommit, '--'], maxBytes);
    const stats = runGit(manifest.projectPath, ['diff', '--stat', baseCommit, headCommit, '--'], maxBytes);
    return { snapshotId, base, head, baseCommit, headCommit, names, stats, truncated: byteLength(names) >= maxBytes || byteLength(stats) >= maxBytes };
  });

  register('repo_context', 'Build Repository Context', 'Combine CodeGraph relationships when its index matches this worktree with raw source search that remains independently complete.', {
    snapshotId: z.string(),
    task: z.string().min(1).max(4000),
    maxNodes: z.number().int().min(1).max(100).default(20),
    maxSearchResults: z.number().int().min(1).max(200).default(50),
  }, async ({ snapshotId, task, maxNodes, maxSearchResults }) => {
    const manifest = store.loadManifest(snapshotId);
    const taskText = String(task);
    const graph = codeGraphContext(manifest.projectPath, taskText, maxNodes);
    const symbolQueries = [...new Set<string>(taskText.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [])].slice(0, 12);
    const search = searchTaskRepository(config, manifest.projectPath, manifest.snapshotId, taskText, symbolQueries, maxSearchResults);
    const symbols = symbolQueries.flatMap((query) => {
      try { return symbolStore.search(snapshotId, query, { limit: 20 }).symbols; } catch { return []; }
    }).slice(0, 100);
    return { snapshotId, branch: manifest.branch, headCommit: manifest.headCommit, graph, search, symbols };
  });

  function register(
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: any) => Promise<any>,
  ): void {
    server.registerTool(name, {
      title,
      description,
      inputSchema,
      outputSchema: resultOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, wrap(name, async (args: any) => {
      const result = await handler(args);
      return {
        content: [{ type: 'text' as const, text: summarizeResult(name, result) }],
        structuredContent: { result },
      };
    }) as never);
  }
}

function searchTaskRepository(
  config: BridgeConfig,
  projectPath: string,
  snapshotId: string,
  task: string,
  symbolQueries: string[],
  maxResults: number,
): Record<string, unknown> {
  const backtickQueries = [...task.matchAll(/`([^`]{2,120})`/g)].map((match) => match[1]);
  const queries = [...new Set([...backtickQueries, ...symbolQueries])].slice(0, 12);
  if (!queries.length) return searchRepository(config, projectPath, snapshotId, task, undefined, maxResults);
  const matches: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const result = searchRepository(config, projectPath, snapshotId, query, undefined, maxResults) as { matches?: Array<{ file: string; line: number; text: string }> };
    for (const match of result.matches ?? []) {
      const key = `${match.file}:${match.line}:${match.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ ...match, query });
      if (matches.length >= maxResults) break;
    }
    if (matches.length >= maxResults) break;
  }
  return { snapshotId, queries, matches, count: matches.length, truncated: matches.length >= maxResults };
}

function compactSymbolIndex(index: ReturnType<SymbolStore['load']>): Record<string, unknown> {
  return {
    status: index.failures.length ? 'partial' : 'complete',
    snapshotId: index.snapshotId,
    supportedFiles: index.supportedFiles,
    unsupportedFiles: index.unsupportedFiles,
    symbols: index.symbols.length,
    failures: index.failures,
  };
}

function compactManifest(manifest: ReturnType<RepoStore['loadManifest']>): Record<string, unknown> {
  return {
    snapshotId: manifest.snapshotId,
    projectPath: manifest.projectPath,
    branch: manifest.branch,
    headCommit: manifest.headCommit,
    dirty: manifest.dirty,
    createdAt: manifest.createdAt,
    trackedFiles: manifest.trackedFiles,
    accountedFiles: manifest.files.length,
    indexedTextFiles: manifest.textFiles,
    indexedLines: manifest.textLines,
    chunks: manifest.chunks.length,
    statuses: manifest.files.reduce<Record<string, number>>((counts, file) => {
      counts[file.status] = (counts[file.status] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

function encodeCursor(snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ snapshotId, offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined, snapshotId: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { snapshotId?: string; offset?: number };
    if (value.snapshotId !== snapshotId) throw new Error('cursor belongs to another snapshot');
    if (!Number.isInteger(value.offset) || (value.offset ?? -1) < 0) throw new Error('cursor offset is invalid');
    return value.offset as number;
  } catch (error) {
    throw new Error(`Invalid repository cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function searchRepository(
  config: BridgeConfig,
  projectPath: string,
  snapshotId: string,
  query: string,
  glob: string | undefined,
  maxResults: number,
): Record<string, unknown> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--fixed-strings'];
  for (const deniedGlob of config.policy.denyGlobs) {
    args.push('-g', `!${deniedGlob}`);
    if (deniedGlob.startsWith('**/')) args.push('-g', `!${deniedGlob.slice(3)}`);
  }
  if (glob) args.push('-g', glob);
  args.push(query, '.');
  try {
    const output = execFileSync('rg', args, { cwd: projectPath, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const matches = output.trim().split('\n').filter(Boolean).slice(0, maxResults).map((line) => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      return match ? { file: toPosix(match[1]), line: Number(match[2]), text: match[3] } : { file: 'unknown', line: 0, text: line };
    });
    return { snapshotId, query, matches, count: matches.length, truncated: matches.length === maxResults };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
    if (status === 1) return { snapshotId, query, matches: [], count: 0, truncated: false };
    throw error;
  }
}

function codeGraphContext(projectPath: string, task: string, maxNodes: number): Record<string, unknown> {
  const executable = process.env.LOCALBRIDGE_CODEGRAPH_BIN ?? 'codegraph';
  try {
    const statusRaw = execFileSync(executable, ['status', projectPath, '--json'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const status = JSON.parse(statusRaw) as Record<string, unknown>;
    const pending = status.pendingChanges as { added?: number; modified?: number; removed?: number } | undefined;
    const pendingCount = (pending?.added ?? 0) + (pending?.modified ?? 0) + (pending?.removed ?? 0);
    const fresh = status.initialized === true && pendingCount === 0 && !status.worktreeMismatch;
    const contextRaw = execFileSync(executable, ['context', task, '--path', projectPath, '--format', 'json', '--max-nodes', String(maxNodes)], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    let context: unknown;
    try { context = JSON.parse(contextRaw); } catch { context = contextRaw.slice(0, 500_000); }
    return { available: true, fresh, status, context };
  } catch (error) {
    return { available: false, fresh: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function runGit(projectPath: string, args: string[], maxBytes: number): string {
  const output = execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', maxBuffer: Math.max(maxBytes * 2, 2 * 1024 * 1024) });
  const buffer = Buffer.from(output);
  return buffer.length <= maxBytes ? output : `${buffer.subarray(0, maxBytes).toString('utf8')}\n... (truncated)`;
}

function resolveGitCommit(projectPath: string, reference: string): string {
  const value = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error(`Git reference did not resolve to a commit: ${reference}`);
  return value;
}

function summarizeResult(name: string, result: Record<string, unknown>): string {
  if (name === 'repo_read' && typeof result.content === 'string') return result.content;
  if (name === 'repo_scan' && Array.isArray(result.chunks)) {
    return result.chunks.map((chunk) => {
      const item = chunk as { file: string; startLine: number; endLine: number; part: number; content: string };
      return `--- ${item.file}:${item.startLine}-${item.endLine} part=${item.part} ---\n${item.content}`;
    }).join('\n');
  }
  return JSON.stringify(result, null, 2).slice(0, 200_000);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
