import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, read } from './helpers.mjs';

test('harvest --extract pulls user messages from transcript fixtures', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const fakeHome = tmpdir();
  const sessDir = path.join(fakeHome, '.claude', 'projects', 'myrepo');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, 'session-1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'harvest this durable sentence please' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>injected noise</system-reminder>' }] } }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'assistant reply not user' }] }),
    ].join('\n')
  );
  const r = run(['harvest', '--days', '7', '--extract'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /harvest this durable sentence/);
  assert.ok(!r.stdout.includes('injected noise'));
  assert.ok(!r.stdout.includes('assistant reply'));
});

test('install --host bogus errors and lists valid hosts', () => {
  const home = tmpdir();
  const r = run(['install', '--host', 'bogus'], { amrHome: home, fakeHome: tmpdir() });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /bogus/);
});

test('install --host codex writes rules + mcp into a fake home, idempotent', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const r1 = run(['install', '--host', 'codex'], { amrHome: home, fakeHome });
  assert.equal(r1.status, 0, r1.stderr);
  const agents = read(path.join(fakeHome, '.codex', 'AGENTS.md')) || '';
  assert.match(agents, /agent-memory/);
  const toml = read(path.join(fakeHome, '.codex', 'config.toml')) || '';
  assert.match(toml, /mcp_servers\.agent-memory/);
  const r2 = run(['install', '--host', 'codex'], { amrHome: home, fakeHome });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout + r2.stderr, /unchanged|already/);
});
