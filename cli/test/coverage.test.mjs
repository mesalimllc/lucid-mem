import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir } from './helpers.mjs';

function setup() {
  const amrHome = tmpdir();
  const fakeHome = tmpdir();
  assert.equal(run(['ensure'], { amrHome, fakeHome }).status, 0);
  return { amrHome, fakeHome };
}

function claudeJsonl(fakeHome, lines) {
  const dir = path.join(fakeHome, '.claude', 'projects', 'projx');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(
    file,
    lines
      .map((text) =>
        JSON.stringify({ type: 'user', message: { content: text } })
      )
      .join('\n')
  );
}

test('coverage reports save rate and lists missed durable signals', () => {
  const { amrHome, fakeHome } = setup();
  run(['add', 'prefers tabs over spaces'], { amrHome, fakeHome });
  claudeJsonl(fakeHome, [
    // saved: near-verbatim in corpus
    'I prefer tabs over spaces everywhere, remember that',
    // durable but never saved
    'we decided the cache TTL should always be 300 seconds',
    // a code dump that merely contains a marker word — excluded
    'const x = () => { if (a) { return b; } }; // never skip this check',
    // ordinary chatter — not durable
    'looks good, ship it',
  ]);
  const r = run(['coverage', '--days', '7', '--no-log'], {
    amrHome,
    fakeHome,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\/2 durable signals covered — save rate 50%/);
  assert.match(r.stdout, /cache TTL should always be 300/);
  assert.ok(!r.stdout.includes('never skip this check'));
});

test('coverage logs a trend line by default; --no-log skips it', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  const log = path.join(amrHome, 'dreams', 'coverage.jsonl');
  run(['coverage', '--no-log'], { amrHome, fakeHome });
  assert.ok(!fs.existsSync(log));
  const r = run(['coverage'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const entry = JSON.parse(readLines(log).at(-1));
  assert.equal(entry.durable, 1);
  assert.equal(entry.covered, 0);
  assert.equal(entry.rate, 0);
});

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}
