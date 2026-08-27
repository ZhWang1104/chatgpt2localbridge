import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RepoStore } from '../dist/repoIndex.js';
import { SymbolStore } from '../dist/symbolIndex.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbridge-repo-'));
const projectPath = path.join(tempDir, 'project');
const dataDir = path.join(tempDir, 'data');
fs.mkdirSync(projectPath);

const git = (...args) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8' }).trim();

try {
  git('init', '-b', 'main');
  git('config', 'user.email', 'bridge-test@example.test');
  git('config', 'user.name', 'Bridge Test');
  fs.mkdirSync(path.join(projectPath, 'src'));
  fs.writeFileSync(path.join(projectPath, 'src', 'small.ts'), [
    'export const alpha = 1;',
    'export function add(beta: number) {',
    '  const gamma = alpha + beta;',
    '  return gamma;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(projectPath, 'src', 'large.txt'), `${'界'.repeat(800)}\n${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n')}\n`);
  fs.writeFileSync(path.join(projectPath, 'src', 'sample.py'), [
    'GLOBAL = 1',
    'def compute(value):',
    '    local_value = GLOBAL + value',
    '    return local_value',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(projectPath, '.env'), 'SECRET=not-readable\n');
  fs.writeFileSync(path.join(projectPath, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  git('add', '.');
  git('commit', '-m', 'fixture');

  const store = new RepoStore({
    dataDir,
    policy: {
      allowedProjectRoots: [projectPath],
      skillRoots: [],
      denyGlobs: ['**/.env', '**/.env.*'],
      shell: { enabled: false, denyPatterns: [] },
    },
  });

  const main = store.open(projectPath, { maxChunkLines: 2, maxChunkBytes: 48 });
  assert.equal(main.branch, 'main');
  assert.equal(main.trackedFiles, 5);
  assert.equal(main.files.length, 5, 'every tracked file must be accounted for');
  assert.equal(main.files.find((file) => file.path === '.env')?.status, 'denied');
  assert.equal(main.files.find((file) => file.path === 'binary.dat')?.status, 'binary');
  assert.equal(main.files.find((file) => file.path === 'src/small.ts')?.status, 'indexed');
  assert.ok(main.chunks.some((chunk) => chunk.file === 'src/large.txt' && chunk.part > 1), 'oversized lines must be split into byte-safe parts');

  const smallChunks = main.chunks.filter((chunk) => chunk.file === 'src/small.ts');
  assert.equal(smallChunks[0].startLine, 1);
  assert.equal(smallChunks.at(-1).endLine, 5);
  assert.equal(store.readChunk(main.snapshotId, smallChunks[0].id).content, 'export const alpha = 1;\nexport function add(beta: number) {\n');

  const scan = store.scanStart(main.snapshotId);
  const first = store.scanNext(scan.id, { maxChunks: 2, maxBytes: 5000 });
  assert.equal(first.chunks.length, 2);
  let coverage = store.coverage(main.snapshotId, scan.id);
  assert.equal(coverage.deliveredChunks, 2);
  assert.equal(coverage.acknowledgedChunks, 0);
  const summaries = Object.fromEntries(first.chunks.map((chunk) => [chunk.id, `summary for ${chunk.file}`]));
  store.scanAck(scan.id, first.chunks.map((chunk) => chunk.id), summaries);
  coverage = store.coverage(main.snapshotId, scan.id);
  assert.equal(coverage.acknowledgedChunks, 2);
  assert.equal(coverage.summarizedChunks, 2);
  const resumedStore = new RepoStore({ dataDir, policy: store['options'].policy });
  assert.deepEqual(resumedStore.scanStatus(scan.id).summaries, summaries, 'scan summaries must survive process restarts');
  assert.equal(store.scanStatus(scan.id).status, 'active');

  const symbolStore = new SymbolStore({ dataDir, policy: store['options'].policy });
  const symbolIndex = symbolStore.index(main.snapshotId);
  assert.equal(symbolIndex.failures.length, 0);
  for (const expected of [
    ['alpha', 'variable', 'definition'],
    ['beta', 'parameter', 'definition'],
    ['gamma', 'variable', 'definition'],
    ['GLOBAL', 'variable', 'definition'],
    ['value', 'parameter', 'definition'],
    ['local_value', 'variable', 'definition'],
  ]) {
    assert.ok(
      symbolIndex.symbols.some((symbol) => symbol.name === expected[0] && symbol.kind === expected[1] && symbol.role === expected[2]),
      `missing symbol ${expected.join('/')}`,
    );
  }
  assert.ok(symbolStore.search(main.snapshotId, 'alpha', { role: 'reference' }).symbols.some((symbol) => symbol.line === 3));

  git('checkout', '-b', 'refactor');
  fs.appendFileSync(path.join(projectPath, 'src', 'small.ts'), 'export const branchOnly = true;\n');
  git('add', '.');
  git('commit', '-m', 'branch change');
  const refactor = store.open(projectPath, { maxChunkLines: 2, maxChunkBytes: 48 });
  assert.equal(refactor.branch, 'refactor');
  assert.notEqual(refactor.snapshotId, main.snapshotId);
  assert.equal(store.loadManifest(main.snapshotId).branch, 'main', 'branch snapshots must remain isolated');

  console.log('[test] repository manifest, chunks, branches, and scan ledger ok');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
