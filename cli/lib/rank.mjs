// Relevance ranking for `amr context`: instead of "newest 25", pick the
// entries most likely to help a fresh session, within a size budget.
// Score = kind weight x recency decay x usage boost, with a penalty for
// session-state-shaped noise. Usage (entries the agent marked via
// `amr used` because they helped) lives in .git/amr-usage.json — local,
// never committed, so ranking is per-machine.

import fs from 'node:fs';
import path from 'node:path';
import { entryKind } from './core.mjs';
import { entryId } from './ids.mjs';

export const DEFAULT_BUDGET = 6000; // chars of entries, roughly 1.5k tokens
export const MIN_PER_SECTION = 3;

const KIND_WEIGHT = {
  pitfall: 3,
  decision: 2.5,
  preference: 2.5,
  howto: 2,
  fact: 1.5,
  state: 1,
};
const HALF_LIFE_DAYS = 60;
const USAGE_WINDOW_DAYS = 90;

const usagePath = (home) => path.join(home, '.git', 'amr-usage.json');

export function loadUsage(home) {
  try {
    const u = JSON.parse(fs.readFileSync(usagePath(home), 'utf8'));
    // Anything but a plain object would crash scoreEntry or lose writes.
    return u && typeof u === 'object' && !Array.isArray(u) ? u : {};
  } catch {
    return {};
  }
}

export function bumpUsage(home, ids, now = Date.now()) {
  if (!ids.length) return;
  const u = loadUsage(home);
  for (const id of ids) {
    const e = u[id] || { n: 0 };
    u[id] = { n: e.n + 1, last: now };
  }
  // Temp file then rename: an interrupted write cannot leave a torn file
  // that loadUsage would then discard along with all usage.
  const abs = usagePath(home);
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(u));
    fs.renameSync(tmp, abs);
  } catch {}
}

const latestDate = (line) => {
  const ds = [...line.matchAll(/(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1])
    .sort();
  return ds.length ? ds[ds.length - 1] : null;
};

export function scoreEntry(line, usage = {}, isNoise = () => false, now = Date.now()) {
  const kind = entryKind(line);
  let s = KIND_WEIGHT[kind] ?? 1.5;
  const d = latestDate(line);
  const ageDays = d ? Math.max(0, (now - Date.parse(d)) / 864e5) : HALF_LIFE_DAYS;
  s *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const u = usage[entryId(line)];
  if (u && now - u.last < USAGE_WINDOW_DAYS * 864e5) s *= 1 + 0.5 * Math.log2(1 + u.n);
  if (kind !== 'state' && isNoise(line)) s *= 0.3;
  return s;
}

// A floor entry that would overrun the budget is clipped to this many
// chars, so the floor bounds the overrun (MIN_PER_SECTION x this per
// section) instead of letting a few huge entries blow the limit.
export const FLOOR_ENTRY_CAP = 240;

// Shorten an entry's text, keeping its trailing [meta] so the id stays
// addressable (`amr search`, `amr update <id>`) after clipping.
export function clipEntry(line, cap = FLOOR_ENTRY_CAP) {
  if (line.length <= cap) return line;
  const meta = (line.match(/\s*\[[^\]]*\]\s*$/) || [''])[0];
  const body = line.slice(0, line.length - meta.length);
  const keep = Math.max(24, cap - meta.length - 1);
  return `${body.slice(0, keep).trimEnd()}…${meta}`;
}

// Highest-scored entries first until `maxCount` or the char budget is
// hit, returned in original order. The top MIN_PER_SECTION entries are
// always kept, clipped when they would not fit, so a section never
// renders empty but also never exceeds the budget by more than the
// floor cap allows.
export function pickWithinBudget(arr, maxCount, budget, usage, isNoise) {
  const ranked = arr
    .map((line, i) => ({ line, i, s: scoreEntry(line, usage, isNoise) }))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  const chosen = [];
  let chars = 0;
  let clipped = false;
  for (const r of ranked) {
    if (chosen.length >= maxCount) break;
    if (chars + r.line.length > budget) {
      if (chosen.length >= MIN_PER_SECTION) continue;
      const line = clipEntry(r.line);
      clipped ||= line !== r.line;
      r.line = line;
    }
    chosen.push(r);
    chars += r.line.length;
  }
  chosen.sort((a, b) => a.i - b.i);
  return { items: chosen.map((r) => r.line), chars, clipped };
}
