import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir, run, CLI } from './helpers.mjs';

// serve is a stdio JSON-RPC server: newline-delimited requests.
function rpc(home, messages, cwd) {
  const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'serve'],
    { input, encoding: 'utf8', env: { ...process.env, AMR_HOME: home }, cwd, timeout: 15_000 }
  );
  return (r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

test('serve answers tools/list with the memory tools', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const out = rpc(home, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
  const resp = out.find((m) => m.id === 1);
  assert.ok(resp, 'no response to tools/list');
  const names = resp.result.tools.map((t) => t.name);
  for (const t of ['memory_context', 'memory_add', 'memory_search', 'memory_update'])
    assert.ok(names.includes(t), `missing tool ${t}`);
});

test('serve memory_context returns the digest as content text', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'mcp round-trip fact'], { amrHome: home });
  const out = rpc(home, [
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_context', arguments: {} } },
  ]);
  const resp = out.find((m) => m.id === 2);
  assert.ok(resp?.result?.content?.[0]?.text?.includes('mcp round-trip fact'));
});

test('serve memory_add takes kind/ttl and memory_update addresses entries by id', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const listed = rpc(home, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
  const add = listed.find((m) => m.id === 1).result.tools.find((t) => t.name === 'memory_add');
  assert.ok(add.inputSchema.properties.kind.enum.includes('state'));
  assert.ok(add.inputSchema.properties.ttl);
  const added = rpc(home, [call(2, 'memory_add', { text: 'PR 9 is open', kind: 'state', ttl: 5 })]);
  const text = added.find((m) => m.id === 2).result.content[0].text;
  const id = text.match(/\[id ([0-9a-f]{4})\]/)?.[1];
  assert.ok(id, text);
  const upd = rpc(home, [call(3, 'memory_update', { id, text: 'PR 9 merged' })]);
  assert.match(upd.find((m) => m.id === 3).result.content[0].text, new RegExp(`updated .*\[id ${id}\]`));
  const none = rpc(home, [call(4, 'memory_update', { text: 'x y' })]);
  assert.equal(none.find((m) => m.id === 4).result.isError, true);
});
