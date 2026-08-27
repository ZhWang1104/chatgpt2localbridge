import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbridge-cli-'));
const workspace = path.join(tempDir, 'workspace');
const configDir = path.join(tempDir, 'config');
const portProbe = net.createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const unusedPort = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
fs.mkdirSync(workspace);
spawnSync('git', ['init', '-b', 'main'], { cwd: workspace });
spawnSync('git', ['config', 'user.email', 'bridge-test@example.test'], { cwd: workspace });
spawnSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: workspace });
fs.writeFileSync(path.join(workspace, 'index.ts'), 'export const indexed = true;\n');
spawnSync('git', ['add', '.'], { cwd: workspace });
spawnSync('git', ['commit', '-m', 'fixture'], { cwd: workspace });

try {
  const setup = spawnSync(process.execPath, [
    'dist/index.js',
    'setup',
    '--root', workspace,
    '--config-dir', configDir,
    '--public-url', 'https://bridge.example.test',
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(setup.status, 0, setup.stderr);

  const policyPath = path.join(configDir, 'bridge.policy.json');
  const envPath = path.join(configDir, '.env.local');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  assert.deepEqual(policy.allowedProjectRoots, [fs.realpathSync(workspace)]);
  assert.equal(policy.shell.enabled, false);
  assert.match(fs.readFileSync(envPath, 'utf8'), /LOCALBRIDGE_TOOL_PROFILE=readonly/);
  assert.match(fs.readFileSync(envPath, 'utf8'), /LOCALBRIDGE_OAUTH_SCOPES="workspace:read"/);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);

  const doctor = spawnSync(process.execPath, [
    'dist/index.js',
    'doctor',
    '--config-dir', configDir,
    '--json',
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, LOCALBRIDGE_PORT: String(unusedPort) },
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.config.ok, true);
  assert.equal(report.policy.ok, true);
  assert.equal(report.workspaceRoots.ok, true);
  assert.equal(report.service.ok, false, 'doctor should report an offline service without failing config checks');

  const indexed = spawnSync(process.execPath, [
    'dist/index.js',
    'index',
    '--root', workspace,
    '--config-dir', configDir,
    '--no-codegraph',
    '--json',
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(indexed.status, 0, indexed.stderr);
  const indexReport = JSON.parse(indexed.stdout);
  assert.equal(indexReport.repository.trackedFiles, 1);
  assert.equal(indexReport.symbols.status, 'complete');
  assert.ok(indexReport.symbols.symbols >= 1);

  console.log('[test] setup, doctor, and index ok');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
