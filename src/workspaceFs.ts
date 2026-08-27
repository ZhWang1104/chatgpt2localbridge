import fs from 'node:fs';
import path from 'node:path';

import type { BridgePolicy } from './config.js';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  modifiedAt: string;
}

export interface WorkspaceListResult {
  items: WorkspaceEntry[];
  truncated: boolean;
}

export interface TextReadResult {
  path: string;
  content: string;
  size: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  nextLine?: number;
}

export class WorkspaceFs {
  readonly allowedRoots: string[];

  constructor(private readonly policy: BridgePolicy) {
    this.allowedRoots = policy.allowedProjectRoots.map((root) => canonicalPath(root));
    if (this.allowedRoots.length === 0) {
      throw new Error('Policy must contain at least one allowed project root');
    }
  }

  resolveProject(requestedPath: string): string {
    const root = canonicalPath(requestedPath);
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${requestedPath}`);
    if (!this.allowedRoots.some((allowed) => isInside(root, allowed))) {
      throw new Error(`Project path is outside allowed roots: ${root}`);
    }
    return root;
  }

  resolveExisting(root: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new Error(`File path must be relative: ${relativePath}`);
    const projectRoot = this.resolveProject(root);
    const lexicalTarget = path.resolve(projectRoot, relativePath);
    if (!isInside(lexicalTarget, projectRoot)) {
      throw new Error(`Path outside project directory: ${relativePath}`);
    }
    this.assertNotDenied(projectRoot, lexicalTarget);

    const realTarget = canonicalPath(lexicalTarget);
    if (!isInside(realTarget, projectRoot)) {
      throw new Error(`Path outside project directory after resolving symlinks: ${relativePath}`);
    }
    this.assertNotDenied(projectRoot, realTarget);
    return realTarget;
  }

  resolveForWrite(root: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new Error(`File path must be relative: ${relativePath}`);
    const projectRoot = this.resolveProject(root);
    const lexicalTarget = path.resolve(projectRoot, relativePath);
    if (!isInside(lexicalTarget, projectRoot)) {
      throw new Error(`Path outside project directory: ${relativePath}`);
    }
    this.assertNotDenied(projectRoot, lexicalTarget);

    let existingAncestor = lexicalTarget;
    while (!lstatExists(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    let realAncestor: string;
    try {
      realAncestor = canonicalPath(existingAncestor);
    } catch (error) {
      if (fs.lstatSync(existingAncestor).isSymbolicLink()) {
        throw new Error(`Unresolvable symlink in write path: ${relativePath}`);
      }
      throw error;
    }
    if (!isInside(realAncestor, projectRoot)) {
      throw new Error(`Path outside project directory after resolving symlinks: ${relativePath}`);
    }
    if (fs.existsSync(lexicalTarget)) {
      const realTarget = canonicalPath(lexicalTarget);
      if (!isInside(realTarget, projectRoot)) {
        throw new Error(`Path outside project directory after resolving symlinks: ${relativePath}`);
      }
    }
    return lexicalTarget;
  }

  resolveAbsolute(requestedPath: string): { root: string; path: string; relativePath: string } {
    if (!path.isAbsolute(requestedPath)) throw new Error(`Path must be absolute: ${requestedPath}`);
    const realTarget = canonicalPath(requestedPath);
    const root = this.allowedRoots
      .filter((allowed) => isInside(realTarget, allowed))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) throw new Error(`Path is outside allowed roots: ${requestedPath}`);
    this.assertNotDenied(root, realTarget);
    return {
      root,
      path: realTarget,
      relativePath: toPosix(path.relative(root, realTarget)),
    };
  }

  readText(root: string, relativePath: string, options: { startLine?: number; maxLines?: number } = {}): TextReadResult {
    const target = this.resolveExisting(root, relativePath);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
    if (isBinaryFile(target)) throw new Error(`Binary file: ${relativePath}`);

    const content = fs.readFileSync(target, 'utf8');
    const lines = content.split('\n');
    const startLine = Math.max(1, options.startLine ?? 1);
    const maxLines = Math.max(1, options.maxLines ?? lines.length);
    const endLine = Math.min(lines.length, startLine + maxLines - 1);
    const selected = lines.slice(startLine - 1, endLine).join('\n');
    return {
      path: toPosix(path.relative(this.resolveProject(root), target)),
      content: selected,
      size: stat.size,
      totalLines: lines.length,
      startLine,
      endLine,
      nextLine: endLine < lines.length ? endLine + 1 : undefined,
    };
  }

  list(
    root: string,
    relativeDirectory: string,
    options: { recursive?: boolean; maxEntries?: number } = {},
  ): WorkspaceListResult {
    const projectRoot = this.resolveProject(root);
    const target = this.resolveExisting(projectRoot, relativeDirectory);
    if (!fs.statSync(target).isDirectory()) throw new Error(`Not a directory: ${relativeDirectory}`);
    const items: WorkspaceEntry[] = [];
    const maxEntries = Math.max(1, options.maxEntries ?? 1000);
    let truncated = false;

    const walk = (directory: string) => {
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const lexicalPath = path.join(directory, entry.name);
        try {
          this.assertNotDenied(projectRoot, lexicalPath);
        } catch {
          continue;
        }
        if (items.length >= maxEntries) {
          truncated = true;
          return;
        }
        const stat = fs.lstatSync(lexicalPath);
        const type = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
        items.push({
          path: toPosix(path.relative(projectRoot, lexicalPath)),
          type,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
        if (options.recursive && entry.isDirectory()) walk(lexicalPath);
        if (truncated) return;
      }
    };

    walk(target);
    return { items, truncated };
  }

  isDenied(root: string, relativePath: string): boolean {
    try {
      this.assertNotDenied(this.resolveProject(root), path.resolve(root, relativePath));
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.includes('denied by policy')) return true;
      throw error;
    }
  }

  private assertNotDenied(root: string, target: string): void {
    const relativePath = toPosix(path.relative(root, target) || '.');
    if (this.policy.denyGlobs.some((glob) => matchesPolicyGlob(relativePath, glob))) {
      throw new Error(`Path is denied by policy: ${relativePath}`);
    }
  }
}

export function matchesPolicyGlob(filePath: string, glob: string): boolean {
  const value = toPosix(filePath).replace(/^\.\//, '');
  const pattern = toPosix(glob).replace(/^\.\//, '');
  const variants = pattern.startsWith('**/') ? [pattern, pattern.slice(3)] : [pattern];
  return variants.some((candidate) => globToRegExp(candidate).test(value));
}

function globToRegExp(glob: string): RegExp {
  let expression = '^';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index++;
        expression += '.*';
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`);
}

function canonicalPath(value: string): string {
  return fs.realpathSync.native(path.resolve(expandHome(value)));
}

function lstatExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value: string): string {
  const home = process.env.HOME ?? '';
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isBinaryFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const sample = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}
