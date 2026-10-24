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

test('uninstall removes only amr wiring and preserves user config', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  // codex with pre-existing user config
  const codexDir = path.join(fakeHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "o4-mini"\n');
  // cursor with a foreign hook that must survive
  const cursorDir = path.join(fakeHome, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  const cursorHooks = path.join(cursorDir, 'hooks.json');
  fs.writeFileSync(
    cursorHooks,
    JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: 'echo user-hook' }] },
    })
  );

  run(['install', '--host', 'codex,cursor'], { amrHome: home, fakeHome });
  assert.match(read(path.join(codexDir, 'config.toml')), /mcp_servers\.agent-memory/);
  assert.match(read(cursorHooks), /amr\.mjs/);

  const r = run(['uninstall', '--host', 'codex,cursor'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);

  // ours removed
  assert.ok(!fs.existsSync(path.join(codexDir, 'AGENTS.md'))); // file was entirely ours
  const toml = read(path.join(codexDir, 'config.toml'));
  assert.ok(!toml.includes('mcp_servers.agent-memory'));
  const hooks = JSON.parse(read(cursorHooks));
  // theirs preserved
  assert.ok(toml.includes('o4-mini'));
  assert.ok(hooks.hooks.sessionStart.some((h) => h.command === 'echo user-hook'));
  assert.ok(!JSON.stringify(hooks).includes('amr.mjs'));
});

test('install --host claude wires Stop→reflect alongside session hooks', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const r = run(['install', '--host', 'claude'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(read(path.join(fakeHome, '.claude', 'settings.json')));
  const cmds = (ev) =>
    (cfg.hooks?.[ev] || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
  assert.ok(cmds('SessionStart').some((c) => c.includes('amr.mjs" context')));
  assert.ok(cmds('SessionEnd').some((c) => c.includes('coverage')));
  const stops = cmds('Stop');
  assert.ok(stops.some((c) => c.includes('amr.mjs" reflect')));
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

test('install --host with one unknown name fails before installing anything', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['install', '--host', 'codex,bogus'], { amrHome: home, fakeHome });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown host\(s\): bogus/);
  // codex was valid, but nothing is installed when any name is a typo
  assert.equal(fs.existsSync(path.join(fakeHome, '.codex')), false);
});

test('install leaves an unparseable MCP config untouched and exits nonzero', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const mcp = path.join(fakeHome, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(mcp), { recursive: true });
  const broken = '{ "mcpServers": { "other": { "command": "x" } }, // trailing comment\n';
  fs.writeFileSync(mcp, broken);
  const r = run(['install', '--host', 'cursor'], { amrHome: home, fakeHome });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /mcp skipped \(unparseable\)/);
  assert.match(r.stderr, /install incomplete for: cursor/);
  // The app's config, and its other servers, survive byte-for-byte.
  assert.equal(fs.readFileSync(mcp, 'utf8'), broken);
});
