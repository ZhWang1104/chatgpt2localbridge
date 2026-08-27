import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BridgePolicy } from './config.js';
import { WorkspaceFs, matchesPolicyGlob } from './workspaceFs.js';

export type RepoFileStatus = 'indexed' | 'denied' | 'binary' | 'symlink' | 'missing' | 'failed';

export interface RepoFileRecord {
  path: string;
  status: RepoFileStatus;
  size: number;
  lines: number;
  sha256?: string;
  error?: string;
}

export interface RepoChunkRecord {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  bytes: number;
  part: number;
  sha256: string;
}

export interface RepoManifest {
  version: 1;
  snapshotId: string;
  projectPath: string;
  branch: string;
  headCommit: string;
  dirty: boolean;
  createdAt: string;
  trackedFiles: number;
  textFiles: number;
  textLines: number;
  files: RepoFileRecord[];
  chunks: RepoChunkRecord[];
}

interface ScanState {
  version: 1;
  id: string;
  snapshotId: string;
  status: 'active' | 'awaiting_ack' | 'complete';
  delivered: string[];
  acknowledged: string[];
  summaries: Record<string, string>;
  failed: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export class RepoStore {
  private readonly workspaceFs: WorkspaceFs;

  constructor(private readonly options: { dataDir: string; policy: BridgePolicy }) {
    this.workspaceFs = new WorkspaceFs(options.policy);
  }

  open(
    requestedProjectPath: string,
    options: { maxChunkLines?: number; maxChunkBytes?: number } = {},
  ): RepoManifest {
    const projectPath = this.workspaceFs.resolveProject(requestedProjectPath);
    const branch = git(projectPath, ['branch', '--show-current']) || 'detached';
    const headCommit = git(projectPath, ['rev-parse', 'HEAD']);
    const dirty = git(projectPath, ['status', '--porcelain']).length > 0;
    const trackedPaths = gitNull(projectPath, ['ls-files', '-z']);
    const files: RepoFileRecord[] = [];
    const chunks: RepoChunkRecord[] = [];
    const maxChunkLines = clamp(options.maxChunkLines ?? 400, 1, 5000);
    const maxChunkBytes = clamp(options.maxChunkBytes ?? 96_000, 1024, 500_000);

    for (const relativePath of trackedPaths.sort((a, b) => a.localeCompare(b))) {
      const normalizedPath = toPosix(relativePath);
      if (this.options.policy.denyGlobs.some((glob) => matchesPolicyGlob(normalizedPath, glob))) {
        files.push({ path: normalizedPath, status: 'denied', size: safeSize(path.join(projectPath, relativePath)), lines: 0 });
        continue;
      }

      const lexicalPath = path.join(projectPath, relativePath);
      if (!fs.existsSync(lexicalPath)) {
        files.push({ path: normalizedPath, status: 'missing', size: 0, lines: 0 });
        continue;
      }

      try {
        const lstat = fs.lstatSync(lexicalPath);
        if (lstat.isSymbolicLink()) {
          files.push({ path: normalizedPath, status: 'symlink', size: lstat.size, lines: 0 });
          continue;
        }
        if (!lstat.isFile()) {
          files.push({ path: normalizedPath, status: 'failed', size: lstat.size, lines: 0, error: 'Tracked path is not a regular file' });
          continue;
        }
        const bytes = fs.readFileSync(this.workspaceFs.resolveExisting(projectPath, normalizedPath));
        const sha256 = digest(bytes);
        if (isBinary(bytes)) {
          files.push({ path: normalizedPath, status: 'binary', size: bytes.length, lines: 0, sha256 });
          continue;
        }
        const fileChunks = buildChunks(normalizedPath, bytes, maxChunkLines, maxChunkBytes);
        const lines = fileChunks.length ? fileChunks[fileChunks.length - 1].endLine : 0;
        files.push({ path: normalizedPath, status: 'indexed', size: bytes.length, lines, sha256 });
        chunks.push(...fileChunks);
      } catch (error) {
        files.push({
          path: normalizedPath,
          status: 'failed',
          size: safeSize(lexicalPath),
          lines: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const identity = JSON.stringify({
      projectPath,
      branch,
      headCommit,
      dirty,
      files: files.map(({ path: file, status, size, lines, sha256 }) => ({ file, status, size, lines, sha256 })),
    });
    const snapshotId = digest(Buffer.from(identity)).slice(0, 24);
    const manifest: RepoManifest = {
      version: 1,
      snapshotId,
      projectPath,
      branch,
      headCommit,
      dirty,
      createdAt: new Date().toISOString(),
      trackedFiles: trackedPaths.length,
      textFiles: files.filter((file) => file.status === 'indexed').length,
      textLines: files.reduce((total, file) => total + file.lines, 0),
      files,
      chunks,
    };
    writeJson(this.manifestPath(snapshotId), manifest);
    return manifest;
  }

  loadManifest(snapshotId: string): RepoManifest {
    return readJson<RepoManifest>(this.manifestPath(assertId(snapshotId)));
  }

  readChunk(snapshotId: string, chunkId: string): RepoChunkRecord & { content: string } {
    const manifest = this.loadManifest(snapshotId);
    const chunk = manifest.chunks.find((candidate) => candidate.id === chunkId);
    if (!chunk) throw new Error(`Unknown chunk: ${chunkId}`);
    const file = manifest.files.find((candidate) => candidate.path === chunk.file);
    if (!file?.sha256) throw new Error(`Indexed file metadata is missing: ${chunk.file}`);
    const target = this.workspaceFs.resolveExisting(manifest.projectPath, chunk.file);
    const bytes = fs.readFileSync(target);
    if (digest(bytes) !== file.sha256) throw new Error(`Snapshot is stale because ${chunk.file} changed`);
    const slice = bytes.subarray(chunk.startOffset, chunk.endOffset);
    if (digest(slice) !== chunk.sha256) throw new Error(`Chunk integrity mismatch: ${chunk.id}`);
    return { ...chunk, content: slice.toString('utf8') };
  }

  readLines(snapshotId: string, filePath: string, startLine = 1, maxLines = 400) {
    const manifest = this.loadManifest(snapshotId);
    const file = manifest.files.find((candidate) => candidate.path === filePath);
    if (!file) throw new Error(`File is not present in snapshot: ${filePath}`);
    if (file.status !== 'indexed' || !file.sha256) throw new Error(`File is not readable (${file.status}): ${filePath}`);
    const target = this.workspaceFs.resolveExisting(manifest.projectPath, file.path);
    const bytes = fs.readFileSync(target);
    if (digest(bytes) !== file.sha256) throw new Error(`Snapshot is stale because ${file.path} changed`);
    const lines = lineRanges(bytes);
    const first = clamp(startLine, 1, Math.max(1, lines.length));
    const count = clamp(maxLines, 1, 5000);
    const selected = lines.slice(first - 1, first - 1 + count);
    const content = selected.length
      ? bytes.subarray(selected[0].start, selected[selected.length - 1].end).toString('utf8')
      : '';
    const endLine = selected.length ? selected[selected.length - 1].line : 0;
    return {
      snapshotId: manifest.snapshotId,
      file: file.path,
      startLine: selected.length ? first : 0,
      endLine,
      totalLines: lines.length,
      nextLine: endLine < lines.length ? endLine + 1 : undefined,
      content,
    };
  }

  scanStart(snapshotId: string): ScanState {
    const manifest = this.loadManifest(snapshotId);
    const now = new Date().toISOString();
    const state: ScanState = {
      version: 1,
      id: randomUUID(),
      snapshotId: manifest.snapshotId,
      status: manifest.chunks.length ? 'active' : 'complete',
      delivered: [],
      acknowledged: [],
      summaries: {},
      failed: {},
      createdAt: now,
      updatedAt: now,
    };
    this.writeScan(state);
    return state;
  }

  scanNext(scanId: string, options: { maxChunks?: number; maxBytes?: number } = {}) {
    const state = this.loadScan(scanId);
    const manifest = this.loadManifest(state.snapshotId);
    const delivered = new Set(state.delivered);
    const maxChunks = clamp(options.maxChunks ?? 4, 1, 20);
    const maxBytes = clamp(options.maxBytes ?? 300_000, 1024, 1_000_000);
    const selected: Array<RepoChunkRecord & { content: string }> = [];
    let bytes = 0;

    for (const chunk of manifest.chunks) {
      if (delivered.has(chunk.id)) continue;
      if (selected.length >= maxChunks) break;
      if (selected.length > 0 && bytes + chunk.bytes > maxBytes) break;
      try {
        const value = this.readChunk(state.snapshotId, chunk.id);
        selected.push(value);
        bytes += chunk.bytes;
        state.delivered.push(chunk.id);
        delivered.add(chunk.id);
      } catch (error) {
        state.failed[chunk.id] = error instanceof Error ? error.message : String(error);
      }
    }

    this.refreshScanStatus(state, manifest);
    this.writeScan(state);
    return { scanId: state.id, snapshotId: state.snapshotId, status: state.status, chunks: selected };
  }

  scanAck(scanId: string, chunkIds: string[], summaries: Record<string, string> = {}): ScanState {
    const state = this.loadScan(scanId);
    const delivered = new Set(state.delivered);
    const acknowledged = new Set(state.acknowledged);
    for (const chunkId of chunkIds) {
      if (!delivered.has(chunkId)) throw new Error(`Chunk was not delivered by this scan: ${chunkId}`);
      acknowledged.add(chunkId);
      const summary = summaries[chunkId]?.trim();
      if (summary) state.summaries[chunkId] = summary.slice(0, 4000);
    }
    state.acknowledged = [...acknowledged];
    this.refreshScanStatus(state, this.loadManifest(state.snapshotId));
    this.writeScan(state);
    return state;
  }

  scanStatus(scanId: string): ScanState {
    const state = this.loadScan(scanId);
    this.refreshScanStatus(state, this.loadManifest(state.snapshotId));
    return state;
  }

  coverage(snapshotId: string, scanId?: string) {
    const manifest = this.loadManifest(snapshotId);
    const state = scanId ? this.loadScan(scanId) : undefined;
    if (state && state.snapshotId !== manifest.snapshotId) throw new Error('Scan belongs to a different snapshot');
    return {
      snapshotId: manifest.snapshotId,
      branch: manifest.branch,
      headCommit: manifest.headCommit,
      trackedFiles: manifest.trackedFiles,
      accountedFiles: manifest.files.length,
      indexedTextFiles: manifest.textFiles,
      indexedLines: manifest.textLines,
      totalChunks: manifest.chunks.length,
      deliveredChunks: state?.delivered.length ?? 0,
      acknowledgedChunks: state?.acknowledged.length ?? 0,
      summarizedChunks: state ? Object.keys(state.summaries).length : 0,
      failedChunks: state ? Object.keys(state.failed).length : 0,
      complete: state?.status === 'complete',
      fileStatuses: countByStatus(manifest.files),
    };
  }

  private manifestPath(snapshotId: string): string {
    return path.join(this.options.dataDir, 'repositories', 'manifests', `${snapshotId}.json`);
  }

  private scanPath(scanId: string): string {
    return path.join(this.options.dataDir, 'repositories', 'scans', `${assertId(scanId)}.json`);
  }

  private loadScan(scanId: string): ScanState {
    const state = readJson<ScanState>(this.scanPath(scanId));
    state.summaries ??= {};
    return state;
  }

  private writeScan(state: ScanState): void {
    state.updatedAt = new Date().toISOString();
    writeJson(this.scanPath(state.id), state);
  }

  private refreshScanStatus(state: ScanState, manifest: RepoManifest): void {
    const total = manifest.chunks.length;
    if (state.acknowledged.length === total && Object.keys(state.failed).length === 0) state.status = 'complete';
    else if (state.delivered.length + Object.keys(state.failed).length >= total) state.status = 'awaiting_ack';
    else state.status = 'active';
  }
}

function buildChunks(file: string, bytes: Buffer, maxLines: number, maxBytes: number): RepoChunkRecord[] {
  const lines = lineRanges(bytes);
  const chunks: RepoChunkRecord[] = [];
  let groupStart = -1;
  let groupEnd = -1;
  let groupStartLine = 0;
  let groupEndLine = 0;
  let groupLines = 0;

  const pushGroup = () => {
    if (groupStart < 0) return;
    chunks.push(makeChunk(file, groupStartLine, groupEndLine, groupStart, groupEnd, 1, bytes));
    groupStart = -1;
    groupEnd = -1;
    groupLines = 0;
  };

  for (const line of lines) {
    const lineBytes = line.end - line.start;
    if (lineBytes > maxBytes) {
      pushGroup();
      let start = line.start;
      let part = 1;
      while (start < line.end) {
        let end = Math.min(start + maxBytes, line.end);
        while (end < line.end && end > start && isUtf8Continuation(bytes[end])) end--;
        if (end === start) end = Math.min(start + maxBytes, line.end);
        chunks.push(makeChunk(file, line.line, line.line, start, end, part++, bytes));
        start = end;
      }
      continue;
    }

    if (groupStart >= 0 && (groupLines >= maxLines || line.end - groupStart > maxBytes)) pushGroup();
    if (groupStart < 0) {
      groupStart = line.start;
      groupStartLine = line.line;
    }
    groupEnd = line.end;
    groupEndLine = line.line;
    groupLines++;
  }
  pushGroup();
  return chunks;
}

function lineRanges(bytes: Buffer): Array<{ line: number; start: number; end: number }> {
  const lines: Array<{ line: number; start: number; end: number }> = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    lines.push({ line, start, end: index + 1 });
    start = index + 1;
    line++;
  }
  if (start < bytes.length) lines.push({ line, start, end: bytes.length });
  return lines;
}

function makeChunk(
  file: string,
  startLine: number,
  endLine: number,
  startOffset: number,
  endOffset: number,
  part: number,
  bytes: Buffer,
): RepoChunkRecord {
  const content = bytes.subarray(startOffset, endOffset);
  const identity = `${file}:${startOffset}:${endOffset}:${digest(content)}`;
  return {
    id: digest(Buffer.from(identity)).slice(0, 24),
    file,
    startLine,
    endLine,
    startOffset,
    endOffset,
    bytes: content.length,
    part,
    sha256: digest(content),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }).trim();
}

function gitNull(cwd: string, args: string[]): string[] {
  const output = execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSize(filePath: string): number {
  try { return fs.lstatSync(filePath).size; } catch { return 0; }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function assertId(value: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return value;
}

function countByStatus(files: RepoFileRecord[]): Record<RepoFileStatus, number> {
  const counts: Record<RepoFileStatus, number> = { indexed: 0, denied: 0, binary: 0, symlink: 0, missing: 0, failed: 0 };
  for (const file of files) counts[file.status]++;
  return counts;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
