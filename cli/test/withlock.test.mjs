import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from '../lib/core.mjs';
import { tmpdir } from './helpers.mjs';

function repoWithLock(content, ageMs = 0) {
  const repo = tmpdir();
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const lock = path.join(repo, '.git', 'amr.lock');
  if (content !== null) {
    fs.writeFileSync(lock, content);
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(lock, t, t);
    }
  }
  return { repo, lock };
}

test('withLock runs fn, returns its value, and removes its lock', () => {
  const { repo, lock } = repoWithLock(null);
  const result = withLock(repo, () => {
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lock), false);
});

test('withLock fails closed when another process holds the lock', () => {
  const { repo, lock } = repoWithLock('other-pid');
  let ran = false;
  // Short retry budget: production defaults stay 15 x 200ms, but the
  // fail-closed path itself must not cost the suite 3s per run.
  const started = Date.now();
  assert.throws(
    () =>
      withLock(
        repo,
        () => {
          ran = true;
        },
        { retries: 2, retryMs: 10 }
      ),
    /could not acquire lock/
  );
  assert.ok(Date.now() - started < 1000, 'fail-closed path blocked on the default retry budget');
  assert.equal(ran, false);
  // The foreign lock is not ours to remove.
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other-pid');
});

test('withLock breaks a stale lock and runs fn', () => {
  const { repo, lock } = repoWithLock('dead-pid', 120_000);
  assert.equal(withLock(repo, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(lock), false);
});

test('withLock releases the lock when fn throws', () => {
  const { repo, lock } = repoWithLock(null);
  assert.throws(() => withLock(repo, () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(fs.existsSync(lock), false);
});
