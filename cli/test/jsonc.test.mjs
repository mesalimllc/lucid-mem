import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addJsoncEntry, readJsonc, removeJsoncEntry, ShapeError } from '../lib/jsonc.mjs';

const SERVER = { command: 'node', args: ['/x/amr.mjs', 'serve'] };
const wired = (text, section) => readJsonc(text).members.find((m) => m.key === section)?.value;

test('readJsonc accepts comments and trailing commas, and rejects broken text', () => {
  const root = readJsonc('{\n  // c\n  "a": [1, 2,], /* b */ "b": "x\\"y",\n}\n');
  assert.equal(root.type, 'object');
  assert.deepEqual(root.members.map((m) => m.key), ['a', 'b']);
  assert.throws(() => readJsonc('{ "a": '), SyntaxError);
  assert.throws(() => readJsonc('{ "a": 1 } extra'), SyntaxError);
  assert.throws(() => readJsonc('{ /* open'), SyntaxError);
});

test('addJsoncEntry creates the file content when the text is empty', () => {
  const out = addJsoncEntry('', 'mcpServers', 'agent-memory', SERVER);
  assert.deepEqual(JSON.parse(out).mcpServers['agent-memory'], SERVER);
});

test('addJsoncEntry adds a section to an empty object and keeps its comment', () => {
  const out = addJsoncEntry('{ // keep me\n}', 'mcpServers', 'agent-memory', SERVER);
  assert.match(out, /\/\/ keep me/);
  assert.equal(wired(out, 'mcpServers').members[0].key, 'agent-memory');
});

test('addJsoncEntry keeps comments, trailing commas and other servers', () => {
  const text = [
    '{',
    '  // user theme',
    '  "theme": "One Dark", // inline',
    '  "mcpServers": {',
    '    "other": { "command": "uvx" }, // keep',
    '  },',
    '}',
    '',
  ].join('\n');
  const out = addJsoncEntry(text, 'mcpServers', 'agent-memory', SERVER);
  assert.match(out, /\/\/ user theme/);
  assert.match(out, /\/\/ inline/);
  assert.match(out, /\/\/ keep/);
  const servers = wired(out, 'mcpServers').members.map((m) => m.key);
  assert.deepEqual(servers, ['other', 'agent-memory']);
});

test('addJsoncEntry adds a section when the root has members but no section', () => {
  const out = addJsoncEntry('{\n  "theme": "x" // t\n}\n', 'mcpServers', 'agent-memory', SERVER);
  assert.equal(readJsonc(out).members.at(0).key, 'theme');
  assert.deepEqual(wired(out, 'mcpServers').members.map((m) => m.key), ['agent-memory']);
});

test('addJsoncEntry returns null when the entry is already present', () => {
  const text = '{ "mcpServers": { "agent-memory": { "command": "node" } } }';
  assert.equal(addJsoncEntry(text, 'mcpServers', 'agent-memory', SERVER), null);
});

test('addJsoncEntry refuses unexpected shapes and broken text', () => {
  assert.throws(() => addJsoncEntry('[1, 2]', 'mcpServers', 'agent-memory', SERVER), ShapeError);
  assert.throws(() => addJsoncEntry('{ "mcpServers": [] }', 'mcpServers', 'agent-memory', SERVER), ShapeError);
  assert.throws(() => addJsoncEntry('{ "theme": ', 'mcpServers', 'agent-memory', SERVER), SyntaxError);
});

test('removeJsoncEntry removes one entry and keeps the rest and its comments', () => {
  const text = '{\n  "mcpServers": {\n    "agent-memory": { "command": "node" },\n    // keep\n    "other": { "command": "uvx" }\n  }\n}';
  const out = removeJsoncEntry(text, 'mcpServers', 'agent-memory');
  assert.match(out, /\/\/ keep/);
  assert.deepEqual(wired(out, 'mcpServers').members.map((m) => m.key), ['other']);
});

test('removeJsoncEntry drops the section once its last entry is removed', () => {
  const text = '{ "theme": "x", "mcpServers": { "agent-memory": { "command": "node" } } }';
  const out = removeJsoncEntry(text, 'mcpServers', 'agent-memory');
  assert.deepEqual(readJsonc(out).members.map((m) => m.key), ['theme']);
});

test('removeJsoncEntry returns null when the entry is absent', () => {
  assert.equal(removeJsoncEntry('{ "mcpServers": {} }', 'mcpServers', 'agent-memory'), null);
  assert.equal(removeJsoncEntry('{}', 'mcpServers', 'agent-memory'), null);
});

test('add then remove round-trips to valid JSON with the user content intact', () => {
  const text = '{\n  // mine\n  "theme": "x",\n}\n';
  const added = addJsoncEntry(text, 'context_servers', 'agent-memory', SERVER);
  const removed = removeJsoncEntry(added, 'context_servers', 'agent-memory');
  assert.match(removed, /\/\/ mine/);
  assert.deepEqual(readJsonc(removed).members.map((m) => m.key), ['theme']);
});
