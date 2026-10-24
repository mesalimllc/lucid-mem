// Reflection review queue. The background judge never writes memory
// directly: its proposals land in dreams/pending-reflections.md, which
// `amr context` lists under "Pending memory candidates" for the next
// session to accept (`amr add` / `amr update <id>`) or ignore. Proposals
// drain when a matching entry is saved and age out after a fortnight.
// Kept apart from pending-saves.md, which `amr coverage` rewrites whole.

import fs from 'node:fs';
import path from 'node:path';
import { today, withLock } from './core.mjs';

export const PENDING_REFLECTIONS = path.join('dreams', 'pending-reflections.md');
const MAX_ITEMS = 15;
const MAX_AGE_DAYS = 14;
const SIMILAR = 0.8;
const HEADER = [
  '# Pending reflections',
  '',
  'Background-judge proposals, unsaved. Review: `amr add` / `amr update <id>` the real ones; ignore the rest.',
  '',
];

const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '') // entry meta
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  );

// Token Jaccard: a cheap paraphrase-blind near-duplicate check, enough to
// stop the same lesson being proposed or saved twice in near-identical
// words. Real paraphrase dedupe is left to the judge, which sees memory.
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export const isNearDuplicate = (text, others) =>
  others.some((o) => similarity(text, o) >= SIMILAR);

// "- [reflect] 2026-10-24 add pitfall project: text"
// "- [reflect] 2026-10-24 update a3f9: text"
const ITEM = /^- \[reflect\] (\d{4}-\d{2}-\d{2}) (.+?): (.*)$/;

function readItems(abs) {
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(ITEM))
    .filter(Boolean)
    .map(([line, date, , text]) => ({ line, date, text }));
}

function writeItems(abs, items) {
  if (!items.length) return fs.rmSync(abs, { force: true });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [...HEADER, ...items.map((i) => i.line)].join('\n') + '\n');
}

const fresh = (date, now) => (Date.parse(now) - Date.parse(date)) / 864e5 <= MAX_AGE_DAYS;

// proposals: [{op:'add'|'update', id?, kind?, project?, text}]
// Returns how many were queued (new, not near-duplicates of queued ones).
export function queueReflections(home, proposals, now = today()) {
  const abs = path.join(home, PENDING_REFLECTIONS);
  return withLock(home, () => {
    const items = readItems(abs).filter((i) => fresh(i.date, now));
    let queued = 0;
    for (const p of proposals) {
      const text = String(p.text).replace(/\s+/g, ' ').trim();
      if (!text || isNearDuplicate(text, items.map((i) => i.text))) continue;
      const head =
        p.op === 'update'
          ? `update ${p.id}`
          : ['add', p.kind, p.project ? 'project' : 'global'].filter(Boolean).join(' ');
      items.push({ line: `- [reflect] ${now} ${head}: ${text}`, date: now, text });
      queued++;
    }
    writeItems(abs, items.slice(-MAX_ITEMS));
    return queued;
  });
}

// Drop queued proposals that a just-saved entry now covers. Called from
// add/update while their lock is already released.
export function drainReflections(home, savedText) {
  const abs = path.join(home, PENDING_REFLECTIONS);
  if (!fs.existsSync(abs)) return;
  withLock(home, () => {
    const items = readItems(abs);
    const kept = items.filter((i) => similarity(i.text, savedText) < SIMILAR);
    if (kept.length !== items.length) writeItems(abs, kept);
  });
}

// Bullet lines for `amr context`, newest first, expired ones skipped.
export function pendingReflectionLines(home, now = today()) {
  return readItems(path.join(home, PENDING_REFLECTIONS))
    .filter((i) => fresh(i.date, now))
    .reverse()
    .map((i) => i.line);
}
