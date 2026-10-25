import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryKind, isExpired } from '../lib/core.mjs';
import { entryId } from '../lib/ids.mjs';

// Kind, expiry and id are read from the trailing [meta] group only, so
// prose in an entry's text cannot hide it (amr context) or delete it (dream --fix).
test('prose "expires:" and "id:" in entry text are not metadata', () => {
  const prose = '- the staging cert expires: 2025-12-01, rotate it [added: 2026-01-02; kind: fact; id: ab12]';
  assert.equal(isExpired(prose, '2026-06-01'), false);
  assert.equal(entryKind(prose), 'fact');
  assert.equal(entryId('- request id: 1234 [added: 2026-01-02; id: ab12]'), 'ab12');
});

test('expires in trailing meta still expires the entry', () => {
  const line = '- scratch note [added: 2026-01-02; expires: 2026-01-04; id: cd34]';
  assert.equal(isExpired(line, '2026-06-01'), true);
  assert.equal(isExpired(line, '2026-01-03'), false);
});
