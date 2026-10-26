// End-to-end tests for server.ps1 against a fake Graph. Needs PowerShell 7 (pwsh) on PATH, or PWSH=/path/to/pwsh.
// Run: npm run test:server
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGraph, SECRET } from './fake-graph.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PWSH = process.env.PWSH || 'pwsh';
const GRAPH_PORT = 9311;
const dir = mkdtempSync(join(tmpdir(), 'iad-'));

function config(port, extra = {}) {
  const file = join(dir, `config-${port}.json`);
  writeFileSync(file, JSON.stringify({
    TenantId: 'contoso.onmicrosoft.com',
    ApplicationId: '11111111-2222-3333-4444-555555555555',
    ClientSecret: SECRET,
    GraphBaseUrl: `http://127.0.0.1:${GRAPH_PORT}/v1.0`,
    GraphBetaBaseUrl: `http://127.0.0.1:${GRAPH_PORT}/beta`,
    AuthorityHost: `http://127.0.0.1:${GRAPH_PORT}`,
    ListenPrefix: `http://127.0.0.1:${port}/`,
    AllowedOrigin: '*',
    EnableRealDelete: false,
    RequestTimeoutSeconds: 15,
    ...extra,
  }));
  return file;
}

function startServer(cfgFile) {
  const p = spawn(PWSH, ['-NoProfile', '-File', join(ROOT, 'server.ps1'), '-ConfigPath', cfgFile, '-NoBrowser']);
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const done = new Promise(r => p.on('exit', code => r(code)));
  return { p, done, output: () => out };
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/session`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

let fake, dryServer, liveServer, dry, live;
const DRY = 8391, LIVE = 8392;

before(async () => {
  fake = await startFakeGraph(GRAPH_PORT);
  dryServer = startServer(config(DRY));
  liveServer = startServer(config(LIVE, { EnableRealDelete: true }));
  dry = await waitUp(DRY);
  live = await waitUp(LIVE);
});

after(() => {
  dryServer && dryServer.p.kill();
  liveServer && liveServer.p.kill();
  fake && fake.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const g = (port, token, path, init = {}) =>
  fetch(`http://127.0.0.1:${port}/graph/beta${path}`, { ...init, headers: { 'X-IAD-Session': token, ...(init.headers || {}) } });

test('session describes the app registration, never the secret', () => {
  assert.equal(dry.mode, 'app');
  assert.equal(dry.tenantLabel, 'contoso.onmicrosoft.com');
  assert.equal(dry.enableRealDelete, false);
  assert.equal(live.enableRealDelete, true);
  assert.ok(dry.roles.includes('Group.ReadWrite.All'));
  assert.match(dry.sessionToken, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(dry).includes(SECRET));
});

test('serves the UI but never config.json, scripts or logs', async () => {
  const ok = await fetch(`http://127.0.0.1:${DRY}/`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
  for (const p of ['/config.json', '/server.ps1', '/config.example.json', '/logs/x.jsonl', '/js/../server.ps1']) {
    assert.equal((await fetch(`http://127.0.0.1:${DRY}${p}`)).status, 404, p);
  }
});

test('Graph calls need the session token', async () => {
  const r = await fetch(`http://127.0.0.1:${DRY}/graph/beta/deviceAppManagement/mobileApps`);
  assert.equal(r.status, 401);
});

test('cross-origin callers are refused', async () => {
  const r = await fetch(`http://127.0.0.1:${DRY}/api/session`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('reads inside the allowlist are proxied, others refused', async () => {
  const apps = await g(DRY, dry.sessionToken, '/deviceAppManagement/mobileApps');
  assert.equal(apps.status, 200);
  assert.ok((await apps.json()).value.length > 0);
  assert.equal((await g(DRY, dry.sessionToken, '/users')).status, 403);
});

test('$batch may only contain reads', async () => {
  const body = reqs => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }) });
  const ok = await g(DRY, dry.sessionToken, '/$batch', body([{ id: '1', method: 'GET', url: 'deviceAppManagement/mobileApps' }]));
  assert.equal(ok.status, 200);
  const bad = await g(DRY, dry.sessionToken, '/$batch', body([{ id: '1', method: 'DELETE', url: 'groups/x' }]));
  assert.equal(bad.status, 403);
});

test('EnableRealDelete=false refuses deletes', async () => {
  const r = await g(DRY, dry.sessionToken, '/groups/00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'RealDeleteDisabled');
});

test('only the three allowed deletes exist, and no other verbs', async () => {
  const t = live.sessionToken;
  assert.equal((await g(LIVE, t, '/deviceManagement/deviceConfigurations/x', { method: 'DELETE' })).status, 403);
  assert.equal((await g(LIVE, t, '/groups/x', { method: 'PATCH', body: '{}' })).status, 405);
  assert.equal((await g(LIVE, t, '/deviceAppManagement/mobileApps', { method: 'POST', body: '{}' })).status, 405);
});

test('live deletes reach Graph and are audited', async () => {
  const t = live.sessionToken;
  const list = await (await g(LIVE, t, '/deviceAppManagement/mobileApps')).json();
  const target = list.value.find(a => a.displayName === 'WinRAR 5.91 (Retired)');
  const r = await g(LIVE, t, `/deviceAppManagement/mobileApps/${target.id}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  const gone = await g(LIVE, t, `/deviceAppManagement/mobileApps/${target.id}/assignments`);
  assert.equal(gone.status, 404);
  const day = new Date().toISOString().slice(0, 10);
  const files = [join(ROOT, 'logs', `audit-${day}.jsonl`)];
  const log = files.filter(existsSync).map(f => readFileSync(f, 'utf8')).join('');
  assert.ok(log.includes(target.id), 'audit log records the delete');
});

test('a wrong secret stops the server with a clear message', async () => {
  const file = config(8393, { ClientSecret: 'wrong' });
  const s = startServer(file);
  const code = await s.done;
  assert.notEqual(code, 0);
  assert.match(s.output(), /AADSTS7000215/);
});

test('a non-loopback ListenPrefix is refused', async () => {
  for (const prefix of ['http://0.0.0.0:8394/', 'http://+:8394/', 'http://myhost.contoso.com:8394/']) {
    const s = startServer(config(8394, { ListenPrefix: prefix }));
    const code = await s.done;
    assert.notEqual(code, 0, prefix);
    assert.match(s.output(), /loopback/, prefix);
  }
});
