import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read } from './helpers.mjs';

function seed(home, repo, text) {
  const r = run(['add', text, '--project'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
}

test('context in a non-git dir shows global memory only', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'prefers tabs'], { amrHome: home });
  const r = run(['context'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prefers tabs/);
});

test('context in a repo shows its project memory', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'app'), 'https://github.com/acme/app.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'app uses redis cache');
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /app uses redis cache/);
});

test('link attaches a sibling project transitively; private blocks transitive only', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'a'), 'https://github.com/acme/a.git');
  const repoB = initRepo(path.join(base, 'b'), 'https://github.com/acme/b.git');
  const repoC = initRepo(path.join(base, 'c'), 'https://github.com/acme/c.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'a uses sqlite');
  seed(home, repoB, 'b uses kafka');
  seed(home, repoC, 'c is a leaf');

  // b links to a
  const link = run(['link', 'a'], { amrHome: home, cwd: repoB });
  assert.equal(link.status, 0);
  const inB = run(['context'], { amrHome: home, cwd: repoB });
  assert.match(inB.stdout, /a uses sqlite/);

  // c links to b; a is private -> transitive refusal in c
  run(['link', 'b'], { amrHome: home, cwd: repoC });
  run(['policy', 'a', 'private', 'true'], { amrHome: home, cwd: repoA });
  const inC = run(['context'], { amrHome: home, cwd: repoC });
  assert.match(inC.stdout, /b uses kafka/);
  assert.match(inC.stdout, /omitted by private policy/);
  assert.ok(!inC.stdout.includes('a uses sqlite'));

  // explicit --also still attaches the private project
  const explicit = run(['context', '--also', 'a'], { amrHome: home, cwd: repoC });
  assert.match(explicit.stdout, /a uses sqlite/);
});

test('unresolved link names surface a marker', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'solo'), 'https://github.com/acme/solo.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'solo entry');
  run(['link', 'ghost-project'], { amrHome: home, cwd: repo });
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.match(r.stdout, /unresolved \(no memory file\): ghost-project/);
});

test('unlink removes the auto-attach', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'x1'), 'https://github.com/acme/x1.git');
  const repoB = initRepo(path.join(base, 'y1'), 'https://github.com/acme/y1.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'x1 fact');
  seed(home, repoB, 'y1 fact');
  run(['link', 'x1'], { amrHome: home, cwd: repoB });
  assert.match(run(['context'], { amrHome: home, cwd: repoB }).stdout, /x1 fact/);
  run(['unlink', 'x1'], { amrHome: home, cwd: repoB });
  assert.ok(!run(['context'], { amrHome: home, cwd: repoB }).stdout.includes('x1 fact'));
});

test('noglobal policy suppresses global memory for that repo', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'iso'), 'https://github.com/acme/iso.git');
  run(['ensure'], { amrHome: home });
  run(['add', 'global pref'], { amrHome: home });
  seed(home, repo, 'iso fact');
  const before = run(['context'], { amrHome: home, cwd: repo });
  assert.match(before.stdout, /global pref/);
  run(['policy', 'iso', 'noglobal', 'true'], { amrHome: home, cwd: repo });
  const after = run(['context'], { amrHome: home, cwd: repo });
  assert.match(after.stdout, /iso fact/);
  assert.ok(!after.stdout.includes('global pref'));
});
