import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, read } from './helpers.mjs';
import { readJsonc } from '../lib/jsonc.mjs';

// run() points APPDATA and XDG_CONFIG_HOME inside fakeHome, so the CLI
// resolves Zed's config dir there on every platform.
const zedDirIn = (fakeHome) =>
  process.platform === 'win32'
    ? path.join(fakeHome, 'AppData', 'Roaming', 'Zed')
    : path.join(fakeHome, '.config', 'zed');

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
  assert.ok(cmds('SessionStart').some((c) => c.includes('--hook')));
  const post = cfg.hooks?.PostToolUse || [];
  assert.ok(
    post.some((e) => e.matcher === 'Bash' && (e.hooks || []).some((h) => h.command.includes('amr.mjs" recall')))
  );
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
  assert.match(agents, /<!-- lucid-mem -->/);
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

test('install migrates pre-rename agent-memory-repo blocks and files; uninstall clears both', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const legacy = '<!-- agent-memory-repo -->\nold rules\n<!-- /agent-memory-repo -->';
  const codexMd = path.join(fakeHome, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(codexMd), { recursive: true });
  fs.writeFileSync(codexMd, `my own rule\n\n${legacy}\n`);
  const rulesDir = path.join(fakeHome, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const oldMdc = path.join(rulesDir, 'agent-memory-repo.mdc');
  fs.writeFileSync(oldMdc, `---\nalwaysApply: true\n---\n\n${legacy}\n`);

  const r = run(['install', '--host', 'codex,cursor'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(codexMd, 'utf8');
  assert.match(text, /my own rule/);
  assert.match(text, /<!-- lucid-mem -->/);
  assert.ok(!text.includes('agent-memory-repo'), 'legacy block replaced');
  assert.equal((text.match(/<!-- lucid-mem -->/g) || []).length, 1);
  assert.ok(!fs.existsSync(oldMdc), 'legacy cursor rule file removed');
  assert.ok(fs.existsSync(path.join(rulesDir, 'lucid-mem.mdc')));

  // uninstall also clears a not-yet-migrated legacy block
  fs.writeFileSync(codexMd, `keep me\n\n${legacy}\n`);
  const u = run(['uninstall', '--host', 'codex'], { amrHome: home, fakeHome });
  assert.equal(u.status, 0, u.stderr);
  const after = fs.readFileSync(codexMd, 'utf8');
  assert.match(after, /keep me/);
  assert.ok(!after.includes('agent-memory-repo'));
});

test('install --host gemini-cli wires MCP and shared GEMINI.md; uninstall preserves shared rules', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const geminiDir = path.join(fakeHome, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  const r1 = run(['install', '--host', 'gemini-cli'], { amrHome: home, fakeHome });
  assert.equal(r1.status, 0, r1.stderr);
  const settingsFile = path.join(geminiDir, 'settings.json');
  const settings = JSON.parse(read(settingsFile));
  assert.equal(settings.mcpServers['agent-memory'].command, 'node');
  assert.deepEqual(settings.mcpServers['agent-memory'].args.slice(-1), ['serve']);
  const rulesFile = path.join(geminiDir, 'GEMINI.md');
  assert.match(read(rulesFile), /lucid-mem/);

  const r2 = run(['install', '--host', 'gemini-cli'], { amrHome: home, fakeHome });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /mcp already wired/);

  // Antigravity also consumes this global GEMINI.md. Removing Gemini CLI
  // must not remove rules while Antigravity remains installed.
  fs.mkdirSync(path.join(geminiDir, 'antigravity-cli'));
  const removed = run(['uninstall', '--host', 'gemini-cli'], { amrHome: home, fakeHome });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /rules retained \(also used by antigravity\)/);
  assert.match(read(rulesFile), /lucid-mem/);
  assert.ok(!JSON.parse(read(settingsFile)).mcpServers?.['agent-memory']);
});

test('install --host zed wires context_servers + personal AGENTS.md, idempotent and reversible', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const zedDir = zedDirIn(fakeHome);
  fs.mkdirSync(zedDir, { recursive: true });
  const settingsFile = path.join(zedDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'One Dark' }));

  const r1 = run(['install', '--host', 'zed'], { amrHome: home, fakeHome });
  assert.equal(r1.status, 0, r1.stderr);
  let settings = JSON.parse(read(settingsFile));
  assert.equal(settings.theme, 'One Dark');
  assert.equal(settings.context_servers['agent-memory'].command, 'node');
  assert.deepEqual(settings.context_servers['agent-memory'].args.slice(-1), ['serve']);
  const agentsFile = path.join(zedDir, 'AGENTS.md');
  assert.match(read(agentsFile), /lucid-mem/);

  const r2 = run(['install', '--host', 'zed'], { amrHome: home, fakeHome });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /mcp already wired/);

  const removed = run(['uninstall', '--host', 'zed'], { amrHome: home, fakeHome });
  assert.equal(removed.status, 0, removed.stderr);
  settings = JSON.parse(read(settingsFile));
  assert.equal(settings.theme, 'One Dark');
  assert.ok(!settings.context_servers);
  assert.ok(!fs.existsSync(agentsFile));
});

test('install --host zed wires JSONC settings and keeps the comments', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const zedDir = zedDirIn(fakeHome);
  fs.mkdirSync(zedDir, { recursive: true });
  const settingsFile = path.join(zedDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{\n  // user comment\n  "theme": "One Dark"\n}\n');

  const r = run(['install', '--host', 'zed'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcp \+agent-memory/);
  const text = read(settingsFile);
  assert.match(text, /\/\/ user comment/);
  assert.equal(readJsonc(text).members.find((m) => m.key === 'context_servers').value.members[0].key, 'agent-memory');
  const removed = run(['uninstall', '--host', 'zed'], { amrHome: home, fakeHome });
  assert.equal(removed.status, 0, removed.stderr);
  const after = read(settingsFile);
  assert.match(after, /\/\/ user comment/);
  assert.deepEqual(readJsonc(after).members.map((m) => m.key), ['theme']);
  assert.ok(!fs.existsSync(path.join(zedDir, 'AGENTS.md')));
});

test('install --host zed leaves unparseable settings untouched and reports skipped MCP', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const zedDir = zedDirIn(fakeHome);
  fs.mkdirSync(zedDir, { recursive: true });
  const settingsFile = path.join(zedDir, 'settings.json');
  const original = '{\n  // user comment\n  "theme": "One Dark"\n';
  fs.writeFileSync(settingsFile, original);

  const r = run(['install', '--host', 'zed'], { amrHome: home, fakeHome });
  // An unparseable host config is a failed install, not a quiet skip.
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /install incomplete for: zed/);
  assert.match(r.stdout, /mcp skipped \(unparseable\)/);
  assert.equal(read(settingsFile), original);
  assert.match(read(path.join(zedDir, 'AGENTS.md')), /lucid-mem/);
});

test('install --host gemini-cli wires commented settings and keeps the comments', () => {
  const home = tmpdir();
  const fakeHome = tmpdir();
  run(['ensure'], { amrHome: home });
  const geminiDir = path.join(fakeHome, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });
  const settingsFile = path.join(geminiDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{\n  // user comment\n  "theme": "Dracula"\n}\n');

  const r = run(['install', '--host', 'gemini-cli'], { amrHome: home, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const text = read(settingsFile);
  assert.match(text, /\/\/ user comment/);
  assert.equal(readJsonc(text).members.find((m) => m.key === 'mcpServers').value.members[0].key, 'agent-memory');
});
