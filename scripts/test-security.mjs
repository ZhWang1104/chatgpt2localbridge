import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { WorkspaceFs } from '../dist/workspaceFs.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbridge-security-'));

try {
  process.env.LOCALBRIDGE_POLICY_PATH = path.join(tempDir, 'missing-policy.json');
  assert.throws(
    () => loadConfig(),
    /Policy file does not exist/,
    'missing policy must fail closed',
  );

  const invalidPolicy = path.join(tempDir, 'invalid-policy.json');
  fs.writeFileSync(invalidPolicy, '{invalid json', 'utf8');
  process.env.LOCALBRIDGE_POLICY_PATH = invalidPolicy;
  assert.throws(
    () => loadConfig(),
    /Failed to load policy/,
    'invalid policy must fail closed',
  );

  const malformedPolicy = path.join(tempDir, 'malformed-policy.json');
  fs.writeFileSync(malformedPolicy, JSON.stringify({ allowedProjectRoots: [tempDir], denyGlobs: '**/.env', shell: { enabled: 'yes' } }));
  process.env.LOCALBRIDGE_POLICY_PATH = malformedPolicy;
  assert.throws(() => loadConfig(), /denyGlobs must be an array|shell.enabled must be a boolean/);

  const workspace = path.join(tempDir, 'workspace');
  const outside = path.join(tempDir, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'visible.ts'), 'export const visible = true;\n');
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=should-not-leak\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape.txt'));
  fs.symlinkSync(outside, path.join(workspace, 'escape-dir'));
  fs.symlinkSync(path.join(outside, 'missing-target'), path.join(workspace, 'dangling'));

  const workspaceFs = new WorkspaceFs({
    allowedProjectRoots: [workspace],
    skillRoots: [],
    denyGlobs: ['**/.env', '**/.env.*'],
    shell: { enabled: false, denyPatterns: [] },
  });
  const root = workspaceFs.resolveProject(workspace);
  assert.equal(workspaceFs.readText(root, 'visible.ts').content, 'export const visible = true;\n');
  assert.throws(() => workspaceFs.readText(root, '.env'), /denied by policy/);
  assert.throws(() => workspaceFs.readText(root, 'escape.txt'), /outside project directory/);
  assert.throws(() => workspaceFs.resolveForWrite(root, 'escape-dir/new-secret.txt'), /outside project directory/);
  assert.throws(() => workspaceFs.resolveForWrite(root, 'dangling'), /symlink/);
  assert.deepEqual(
    workspaceFs.list(root, '.', { recursive: true, maxEntries: 100 }).items.map((entry) => entry.path),
    ['dangling', 'escape-dir', 'escape.txt', 'visible.ts'],
    'directory listing must filter denied paths',
  );

  const validPolicy = path.join(tempDir, 'valid-policy.json');
  fs.writeFileSync(validPolicy, JSON.stringify({
    allowedProjectRoots: [workspace],
    skillRoots: [],
    denyGlobs: ['**/.env', '**/.env.*'],
    shell: { enabled: false, denyPatterns: [] },
  }));
  process.env.LOCALBRIDGE_POLICY_PATH = validPolicy;
  delete process.env.LOCALBRIDGE_TOOL_PROFILE;
  delete process.env.LOCALBRIDGE_OAUTH_SCOPES;
  const safeConfig = loadConfig();
  assert.equal(safeConfig.toolProfile, 'readonly');
  assert.deepEqual(safeConfig.oauth.scopes, ['workspace:read']);

  const callTool = (name, args, envOverrides = {}) => {
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'security-test', version: '0.1.0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
      '',
    ].join('\n');
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        LOCALBRIDGE_POLICY_PATH: validPolicy,
        LOCALBRIDGE_DATA_DIR: path.join(tempDir, 'data'),
        LOCALBRIDGE_LOG_DIR: path.join(tempDir, 'logs'),
        LOCALBRIDGE_PORT: '',
        LOCALBRIDGE_TOOL_PROFILE: 'readonly',
        ...envOverrides,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\n+/).map(JSON.parse).find((line) => line.id === 2)?.result;
  };

  const listed = callTool('file.list', { projectPath: workspace, dir: '.', recursive: true, maxEntries: 100 });
  assert.ok(!listed.structuredContent.entries.some((entry) => entry.path === '.env'));
  const searched = callTool('code.search', { projectPath: workspace, query: 'should-not-leak', maxResults: 100 });
  assert.equal(searched.structuredContent.count, 0, 'search must not return denied file content');
  const emptyBin = path.join(tempDir, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const searchedWithoutRg = callTool(
    'code.search',
    { projectPath: workspace, query: 'visible', maxResults: 100 },
    { PATH: emptyBin },
  );
  assert.equal(searchedWithoutRg.structuredContent.count, 1, 'search must use a safe built-in fallback when rg is unavailable');

  console.log('[test] fail-closed policy and workspace boundary ok');
} finally {
  delete process.env.LOCALBRIDGE_POLICY_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
