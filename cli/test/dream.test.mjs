import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, read, entries } from './helpers.mjs';

function seeded() {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  return home;
}

test('dream --json returns a health report', () => {
  const home = seeded();
  run(['add', 'one fact'], { amrHome: home });
  const r = run(['dream', '--json'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.stats.entries, 'number');
  assert.ok(Array.isArray(j.exactDups));
});

test('dream --fix dedupes repeated entries', () => {
  const home = seeded();
  const mem = path.join(home, 'MEMORY.md');
  // bypass near-dup skip by writing raw duplicates
  fs.appendFileSync(mem, '- duplicate line [added: 2026-01-01]\n');
  fs.appendFileSync(mem, '- duplicate line [added: 2026-01-02]\n');
  const r = run(['dream', '--fix'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const count = entries(mem).filter((l) => l.includes('duplicate line')).length;
  assert.equal(count, 1);
});

test('dream --compact --keep archives overflow entries', () => {
  const home = seeded();
  for (let i = 0; i < 5; i++) run(['add', `entry number ${i}`], { amrHome: home });
  const r = run(['dream', '--fix', '--compact', '--keep', '2'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(entries(path.join(home, 'MEMORY.md')).length <= 2 + 1); // +index tolerance
  const arch = fs.readdirSync(path.join(home, 'archive'));
  assert.ok(arch.length > 0);
});

test('dream --if-stale no-ops right after a dream', () => {
  const home = seeded();
  run(['add', 'stale check'], { amrHome: home });
  run(['dream', '--fix'], { amrHome: home });
  const r = run(['dream', '--if-stale', '30', '--json'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  // second run should not rewrite the tree
  const mem1 = read(path.join(home, 'MEMORY.md'));
  run(['dream', '--if-stale', '30', '--fix'], { amrHome: home });
  assert.equal(read(path.join(home, 'MEMORY.md')), mem1);
});
