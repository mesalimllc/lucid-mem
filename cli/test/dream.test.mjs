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

test('dream --triage plans first, then --apply keeps, rewrites and archives', () => {
  const home = seeded();
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    [
      '# Memory',
      '',
      '- merged to main as 93372492 via PR #789 [added: 2026-10-24; id: a001]',
      '- worker testTimeout is 45s; raised to 120s in a6ca4a54 (PR #770) [added: 2026-10-22; id: a002]',
      '- Fortune row fix landed in run 40046098775 [added: 2026-10-22; id: a003]',
      '- prefers tabs over spaces [added: 2026-10-22; id: a004]',
      '- typed already with PR #12 [added: 2026-10-22; kind: fact; id: a005]',
      '',
      '## Index',
      '',
    ].join('\n')
  );
  run(['index'], { amrHome: home });
  const judge = path.join(home, '..', `triage-judge-${process.pid}.mjs`);
  const seen = `${judge}.prompt`;
  fs.writeFileSync(
    judge,
    'import fs from "node:fs";' +
      `fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(0, "utf8"));` +
      'console.log(JSON.stringify([' +
      '{id:"a001",action:"archive"},' +
      '{id:"a002",action:"rewrite",kind:"fact",text:"The worker vitest project testTimeout is 120s."},' +
      '{id:"a003",action:"keep",kind:"fact"},' +
      '{id:"zzzz",action:"archive"}]));'
  );
  const env = { AMR_JUDGE_CMD: `"${process.execPath}" "${judge}"`, AMR_TRIAGE_JUDGE: 'env' };
  const before = read(mem);

  const p = run(['dream', '--triage'], { amrHome: home, env });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /keep 1, rewrite 1, archive 1/);
  // Only untyped, session-state-looking entries reach the judge.
  const prompt = fs.readFileSync(seen, 'utf8');
  assert.match(prompt, /a001\t/);
  assert.doesNotMatch(prompt, /a004|a005/);
  // Planning never touches memory.
  assert.equal(read(mem), before);

  const a = run(['dream', '--triage', '--apply'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /kept 1, rewrote 1, archived 1/);
  const after = read(mem);
  assert.doesNotMatch(after, /93372492/);
  assert.match(after, /- The worker vitest project testTimeout is 120s\. \[added: 2026-10-22; id: a002; kind: fact\]/);
  assert.match(after, /run 40046098775 \[added: 2026-10-22; id: a003; kind: fact\]/);
  assert.match(after, /prefers tabs over spaces/);
  // Archived, not deleted: still searchable.
  const archive = read(path.join(home, 'archive', 'MEMORY.md'));
  assert.match(archive, /93372492/);
  // A rewrite keeps its original in the archive too.
  assert.match(archive, /raised to 120s in a6ca4a54/);
  assert.match(run(['search', '93372492'], { amrHome: home }).stdout, /archive\/MEMORY\.md/);
  assert.equal(fs.existsSync(path.join(home, 'dreams', 'triage-plan.json')), false);
});

test('dream --triage --apply skips entries edited after planning', () => {
  const home = seeded();
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(mem, '# Memory\n\n- merged as 93372492 [added: 2026-10-24; id: b001]\n\n## Index\n');
  fs.mkdirSync(path.join(home, 'dreams'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'dreams', 'triage-plan.json'),
    JSON.stringify({ items: [{ id: 'b001', rel: 'MEMORY.md', original: 'something else', action: 'archive' }] })
  );
  const a = run(['dream', '--triage', '--apply'], { amrHome: home });
  assert.match(a.stdout, /archived 0, skipped 1 changed since planning/);
  assert.match(read(mem), /93372492/);
});
