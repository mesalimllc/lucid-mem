import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read, entries } from './helpers.mjs';

test('ensure creates repo, MEMORY.md with index, idempotent', () => {
  const home = tmpdir();
  const r1 = run(['ensure'], { amrHome: home });
  assert.equal(r1.status, 0, r1.stderr);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /# Memory/);
  assert.match(mem, /## Index/);
  assert.ok(fs.existsSync(path.join(home, '.git')));
  const r2 = run(['ensure'], { amrHome: home });
  assert.equal(r2.status, 0);
});

test('ensure refuses a non-empty non-repo dir', () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, 'junk.txt'), 'x');
  const r = run(['ensure'], { amrHome: home });
  assert.notEqual(r.status, 0);
});

test('add appends a dated bullet to MEMORY.md', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'prefers bullet points'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const lines = entries(path.join(home, 'MEMORY.md'));
  assert.ok(lines.some((l) => l.includes('prefers bullet points')));
  assert.match(lines[lines.length - 1], /\[added: \d{4}-\d{2}-\d{2}/);
});

test('add refuses secret-shaped text; --allow-secret overrides', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'api key is ghp_abcdefghijklmnop1234567890'], { amrHome: home });
  assert.notEqual(r.status, 0);
  assert.ok(!(read(path.join(home, 'MEMORY.md')) || '').includes('ghp_'));
  const r2 = run(['add', 'api key is ghp_abcdefghijklmnop1234567890', '--allow-secret'], {
    amrHome: home,
  });
  assert.equal(r2.status, 0);
});

test('add skips near-duplicates', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'uses dark mode'], { amrHome: home });
  const r = run(['add', 'uses dark mode'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.equal(
    entries(path.join(home, 'MEMORY.md')).filter((l) => l.includes('dark mode')).length,
    1
  );
});

test('add --file writes a topic file and indexes it', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'prefers pnpm', '--file', 'tooling'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.ok(read(path.join(home, 'tooling.md')).includes('prefers pnpm'));
  assert.match(read(path.join(home, 'MEMORY.md')), /\[\[tooling\]\]/);
});

test('update replaces an entry and keeps metadata', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'port is 3000'], { amrHome: home });
  const r = run(['update', 'port is', 'port is 8080'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /port is 8080/);
  assert.match(mem, /updated: \d{4}-\d{2}-\d{2}/);
  assert.ok(!mem.includes('port is 3000'));
});

test('update errors on zero and multiple matches', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'alpha entry'], { amrHome: home });
  run(['add', 'alpha two'], { amrHome: home });
  const none = run(['update', 'no-such-text', 'x'], { amrHome: home });
  assert.notEqual(none.status, 0);
  const many = run(['update', 'alpha', 'x'], { amrHome: home });
  assert.notEqual(many.status, 0);
});

test('search finds entries; index rebuilds', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'kokoro for tts'], { amrHome: home });
  const r = run(['search', 'kokoro'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kokoro/);
  const ri = run(['index'], { amrHome: home });
  assert.equal(ri.status, 0);
});

test('add --project routes to projects/<slug>.md', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'myproj'), 'https://github.com/acme/myproj.git');
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'uses pnpm workspaces', '--project'], {
    amrHome: home,
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  const projDir = path.join(home, 'projects');
  const files = fs.readdirSync(projDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^myproj-[0-9a-f]{6}\.md$/);
  assert.ok(read(path.join(projDir, files[0])).includes('pnpm workspaces'));
});
