import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import type { BridgePolicy } from './config.js';
import { RepoStore } from './repoIndex.js';
import { WorkspaceFs } from './workspaceFs.js';

export type SymbolRole = 'definition' | 'reference';
export type SymbolKind = 'variable' | 'parameter' | 'property' | 'function' | 'class' | 'interface' | 'type' | 'import' | 'identifier';

export interface SymbolRecord {
  name: string;
  file: string;
  line: number;
  column: number;
  kind: SymbolKind;
  role: SymbolRole;
  language: 'typescript' | 'javascript' | 'python';
}

export interface SymbolIndex {
  version: 1;
  snapshotId: string;
  createdAt: string;
  supportedFiles: number;
  unsupportedFiles: number;
  symbols: SymbolRecord[];
  failures: Array<{ file: string; error: string }>;
}

export class SymbolStore {
  private readonly repoStore: RepoStore;
  private readonly workspaceFs: WorkspaceFs;

  constructor(private readonly options: { dataDir: string; policy: BridgePolicy }) {
    this.repoStore = new RepoStore(options);
    this.workspaceFs = new WorkspaceFs(options.policy);
  }

  index(snapshotId: string): SymbolIndex {
    const manifest = this.repoStore.loadManifest(snapshotId);
    const symbols: SymbolRecord[] = [];
    const failures: Array<{ file: string; error: string }> = [];
    const pythonFiles: string[] = [];
    let supportedFiles = 0;
    let unsupportedFiles = 0;

    for (const file of manifest.files) {
      if (file.status !== 'indexed') continue;
      const extension = path.extname(file.path).toLowerCase();
      if (extension === '.py') {
        pythonFiles.push(file.path);
        supportedFiles++;
        continue;
      }
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
        unsupportedFiles++;
        continue;
      }
      supportedFiles++;
      try {
        const target = this.workspaceFs.resolveExisting(manifest.projectPath, file.path);
        const bytes = fs.readFileSync(target);
        if (file.sha256 && digest(bytes) !== file.sha256) throw new Error('snapshot is stale');
        const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX
          : extension === '.jsx' ? ts.ScriptKind.JSX
            : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS
              : ts.ScriptKind.TS;
        const source = ts.createSourceFile(file.path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, scriptKind);
        const diagnostics = ((source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [])
          .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
        if (diagnostics.length) {
          failures.push({ file: file.path, error: diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ') });
        }
        collectTypeScriptSymbols(source, file.path, symbols, scriptKind === ts.ScriptKind.JS ? 'javascript' : 'typescript');
      } catch (error) {
        failures.push({ file: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (pythonFiles.length) {
      try {
        const result = extractPythonSymbols(manifest.projectPath, pythonFiles);
        symbols.push(...result.symbols);
        failures.push(...result.failures);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(...pythonFiles.map((file) => ({ file, error: `Python AST unavailable: ${message}` })));
      }
    }

    symbols.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
    const index: SymbolIndex = {
      version: 1,
      snapshotId: manifest.snapshotId,
      createdAt: new Date().toISOString(),
      supportedFiles,
      unsupportedFiles,
      symbols,
      failures,
    };
    writeJson(this.indexPath(manifest.snapshotId), index);
    return index;
  }

  load(snapshotId: string): SymbolIndex {
    return JSON.parse(fs.readFileSync(this.indexPath(assertId(snapshotId)), 'utf8')) as SymbolIndex;
  }

  search(
    snapshotId: string,
    query: string,
    options: { role?: SymbolRole; kind?: SymbolKind; limit?: number } = {},
  ) {
    let index: SymbolIndex;
    try { index = this.load(snapshotId); } catch { index = this.index(snapshotId); }
    const needle = query.toLowerCase();
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const matches = index.symbols.filter((symbol) =>
      symbol.name.toLowerCase().includes(needle)
      && (!options.role || symbol.role === options.role)
      && (!options.kind || symbol.kind === options.kind),
    );
    return {
      snapshotId,
      query,
      symbols: matches.slice(0, limit),
      totalMatches: matches.length,
      truncated: matches.length > limit,
      supportedFiles: index.supportedFiles,
      unsupportedFiles: index.unsupportedFiles,
      failures: index.failures,
    };
  }

  private indexPath(snapshotId: string): string {
    return path.join(this.options.dataDir, 'repositories', 'symbols', `${snapshotId}.json`);
  }
}

function collectTypeScriptSymbols(
  source: ts.SourceFile,
  file: string,
  output: SymbolRecord[],
  language: 'typescript' | 'javascript',
): void {
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      const classification = classifyTypeScriptIdentifier(node);
      output.push({
        name: node.text,
        file,
        line: location.line + 1,
        column: location.character + 1,
        kind: classification.kind,
        role: classification.role,
        language,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function classifyTypeScriptIdentifier(node: ts.Identifier): { kind: SymbolKind; role: SymbolRole } {
  const parent = node.parent;
  if (ts.isParameter(parent) && isWithinName(node, parent.name)) return { kind: 'parameter', role: 'definition' };
  if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && isWithinName(node, parent.name)) return { kind: 'variable', role: 'definition' };
  if ((ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return { kind: 'property', role: 'definition' };
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return { kind: 'function', role: 'definition' };
  if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === node) return { kind: 'class', role: 'definition' };
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return { kind: 'interface', role: 'definition' };
  if ((ts.isTypeAliasDeclaration(parent) || ts.isTypeParameterDeclaration(parent)) && parent.name === node) return { kind: 'type', role: 'definition' };
  if ((ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) && (parent.name === node || ('propertyName' in parent && parent.propertyName === node))) {
    return { kind: 'import', role: 'definition' };
  }
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)) {
    return { kind: 'property', role: 'reference' };
  }
  return { kind: 'identifier', role: 'reference' };
}

function isWithinName(node: ts.Identifier, name: ts.BindingName): boolean {
  if (name === node) return true;
  return name.getStart() <= node.getStart() && node.getEnd() <= name.getEnd();
}

function extractPythonSymbols(projectPath: string, files: string[]): { symbols: SymbolRecord[]; failures: Array<{ file: string; error: string }> } {
  const output = execFileSync('python3', ['-c', PYTHON_AST_SCRIPT], {
    input: JSON.stringify({ projectPath, files }),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(output) as { symbols: SymbolRecord[]; failures: Array<{ file: string; error: string }> };
}

const PYTHON_AST_SCRIPT = String.raw`
import ast, json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(payload["projectPath"])
symbols, failures = [], []

def add(name, file, node, kind, role):
    symbols.append({"name": name, "file": file, "line": getattr(node, "lineno", 1), "column": getattr(node, "col_offset", 0) + 1, "kind": kind, "role": role, "language": "python"})

class Visitor(ast.NodeVisitor):
    def __init__(self, file): self.file = file
    def visit_FunctionDef(self, node):
        add(node.name, self.file, node, "function", "definition"); self.generic_visit(node)
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_ClassDef(self, node):
        add(node.name, self.file, node, "class", "definition"); self.generic_visit(node)
    def visit_arg(self, node):
        add(node.arg, self.file, node, "parameter", "definition"); self.generic_visit(node)
    def visit_Name(self, node):
        add(node.id, self.file, node, "variable" if isinstance(node.ctx, ast.Store) else "identifier", "definition" if isinstance(node.ctx, ast.Store) else "reference")
    def visit_Attribute(self, node):
        add(node.attr, self.file, node, "property", "definition" if isinstance(node.ctx, ast.Store) else "reference"); self.generic_visit(node)
    def visit_alias(self, node):
        add(node.asname or node.name.split(".")[0], self.file, node, "import", "definition")

for rel in payload["files"]:
    full = os.path.realpath(os.path.join(root, rel))
    if os.path.commonpath([root, full]) != root:
        failures.append({"file": rel, "error": "outside project root"}); continue
    try:
        with open(full, "r", encoding="utf-8") as handle: tree = ast.parse(handle.read(), filename=rel)
        Visitor(rel).visit(tree)
    except Exception as exc:
        failures.append({"file": rel, "error": str(exc)})
print(json.dumps({"symbols": symbols, "failures": failures}, ensure_ascii=False))
`;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertId(value: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
