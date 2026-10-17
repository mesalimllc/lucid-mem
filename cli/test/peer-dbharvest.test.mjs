import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run,
  tmpdir,
  initRepo,
  git,
  read,
} from './helpers.mjs';

const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const hasSqlite = !!DatabaseSync;

function setup() {
  const amrHome = tmpdir();
  const fakeHome = tmpdir();
  const r = run(['ensure'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  return { amrHome, fakeHome };
}

function initPeerRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  fs.writeFileSync(
    path.join(dir, 'MEMORY.md'),
    '# Memory\n\n- teammate global fact: prefers tabs over spaces [added: 2026-01-01]\n'
  );
  git(dir, [
    '-c', 'user.email=t@t.dev', '-c', 'user.name=t',
    'add', '-A',
  ]);
  git(dir, [
    '-c', 'user.email=t@t.dev', '-c', 'user.name=t',
    'commit', '-m', 'mem',
  ]);
  return dir;
}

test('peer add clones and lists; remove detaches', () => {
  const { amrHome, fakeHome } = setup();
  const peerSrc = initPeerRepo(path.join(tmpdir(), 'teammate-mem'));
  let r = run(['peer', 'add', peerSrc], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /peer teammate-mem/);
  assert.ok(
    fs.existsSync(
      path.join(path.dirname(amrHome), `${path.basename(amrHome)}-peers`, 'teammate-mem', 'MEMORY.md')
    )
  );
  r = run(['peer'], { amrHome, fakeHome });
  assert.match(r.stdout, /teammate-mem.*cloned/);
  r = run(['peer', 'remove', 'teammate-mem'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  r = run(['peer'], { amrHome, fakeHome });
  assert.match(r.stdout, /no peers configured/);
});

test('context composes peer global + matching project memory', () => {
  const { amrHome, fakeHome } = setup();
  // Seed a project in OUR repo so the slug exists.
  const repo = initRepo(path.join(tmpdir(), 'projx'));
  run(['add', 'our project note', '--project'], {
    amrHome, fakeHome, cwd: repo,
  });
  const slug = fs
    .readdirSync(path.join(amrHome, 'projects'))
    .find((f) => f.endsWith('.md'))
    .replace(/\.md$/, '');
  // Peer carries its own memory file for the same slug.
  const peerSrc = initPeerRepo(path.join(tmpdir(), 'workmate'));
  fs.mkdirSync(path.join(peerSrc, 'projects'));
  fs.writeFileSync(
    path.join(peerSrc, 'projects', `${slug}.md`),
    `# Project: projx\n\n- teammate project note: api uses v2 endpoints [added: 2026-01-01]\n`
  );
  git(peerSrc, [
    '-c', 'user.email=t@t.dev', '-c', 'user.name=t',
    'add', '-A',
  ]);
  git(peerSrc, [
    '-c', 'user.email=t@t.dev', '-c', 'user.name=t',
    'commit', '-m', 'add proj',
  ]);
  const r = run(['peer', 'add', peerSrc], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const ctx = run(['context', repo], { amrHome, fakeHome });
  assert.equal(ctx.status, 0, ctx.stderr);
  assert.match(ctx.stdout, /## Peer: workmate \(read-only\)/);
  assert.match(ctx.stdout, /prefers tabs over spaces/);
  assert.match(ctx.stdout, /### workmate memory for this project/);
  assert.match(ctx.stdout, /api uses v2 endpoints/);
});

test('context flags configured-but-missing peer clones', () => {
  const { amrHome, fakeHome } = setup();
  const peerSrc = initPeerRepo(path.join(tmpdir(), 'gonemate'));
  run(['peer', 'add', peerSrc], { amrHome, fakeHome });
  fs.rmSync(
    path.join(path.dirname(amrHome), `${path.basename(amrHome)}-peers`, 'gonemate'),
    { recursive: true, force: true }
  );
  const ctx = run(['context'], { amrHome, fakeHome });
  assert.match(ctx.stdout, /configured peer\(s\) not cloned: gonemate/);
});

test('harvest extracts opencode sqlite user messages', { skip: !hasSqlite }, () => {
  const { amrHome, fakeHome } = setup();
  const dir = path.join(fakeHome, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(
    'create table message(id text, session_id text, time_created integer, data text);' +
      'create table part(id text, message_id text, session_id text, time_created integer, data text);'
  );
  db.prepare('insert into message values (?,?,?,?)').run(
    'm1', 's1', Date.now(),
    JSON.stringify({ role: 'user' })
  );
  db.prepare('insert into part values (?,?,?,?,?)').run(
    'p1', 'm1', 's1', Date.now(),
    JSON.stringify({ type: 'text', text: 'please fix the flaky login test in CI' })
  );
  db.close();
  const r = run(['harvest', '--days', '7', '--extract'], {
    amrHome, fakeHome,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[opencode\].*flaky login test/);
});

test('harvest extracts antigravity protobuf user prompts', { skip: !hasSqlite }, () => {
  const { amrHome, fakeHome } = setup();
  const dir = path.join(fakeHome, '.gemini', 'antigravity', 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'conv1.db'));
  db.exec('create table steps(idx integer, step_type integer, step_payload blob)');
  // Protobuf-ish bytes: tag + uuid junk + the user string as a printable run.
  const payload = Buffer.concat([
    Buffer.from([0x08, 0x0e, 0x32, 0x03]),
    Buffer.from('b$85b47905-028a-4ca9-bd54-0a36d1d712fa\x00'),
    Buffer.from('why does the build cache never invalidate on rename'),
    Buffer.from([0x00, 0x01, 0x02]),
  ]);
  db.prepare('insert into steps values (?,?,?)').run(0, 14, payload);
  // A tool step should be ignored.
  db.prepare('insert into steps values (?,?,?)').run(
    1, 8, Buffer.from('{"AbsolutePath":"d:/x/y.md","EndLine":100,"toolAction":"Listing dir contents here"}')
  );
  db.close();
  const r = run(['harvest', '--days', '7', '--extract'], {
    amrHome, fakeHome,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[antigravity\].*build cache never invalidate/);
  assert.doesNotMatch(r.stdout, /Listing dir contents/);
});
