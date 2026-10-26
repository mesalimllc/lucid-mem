// Budget-pressure consolidation. The context digest has a fixed char
// budget; once a live file's entries approach it, the next writes get
// ranked out of sessions entirely. Rather than fail at the wall, `amr
// add` and `amr dream` propose concrete merges when a file crosses the
// threshold: near-duplicate pairs get a delete suggestion, expired and
// session-state-looking entries get delete/re-scope suggestions. The
// proposals surface under "Pending memory candidates" via pending.mjs.

import fs from 'node:fs';
import path from 'node:path';
import {
  episodicHits,
  entryKind,
  isExpired,
  loadConfig,
  numFlag,
} from './core.mjs';
import { entryId } from './ids.mjs';
import { DEFAULT_BUDGET, loadUsage, scoreEntry } from './rank.mjs';
import { similarity } from './pending.mjs';

export const CONSOLIDATE_AT = 0.8;
const MERGE_SIMILARITY = 0.5; // below `amr add`'s 0.8 block, above noise
const MAX_PROPOSALS = 5;

// Live entry lines of a memory file; MEMORY.md's Index section is links,
// not entries, so it stops counting there.
export function liveEntryLines(home, rel) {
  const abs = path.join(home, rel);
  if (!fs.existsSync(abs)) return [];
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const end =
    rel === 'MEMORY.md'
      ? (() => {
          const i = lines.findIndex((l) => /^##\s+Index/.test(l));
          return i < 0 ? lines.length : i;
        })()
      : lines.length;
  const out = [];
  for (let i = 0; i < end; i++)
    if (lines[i].trim().startsWith('- ') && !lines[i].includes('[['))
      out.push(lines[i]);
  return out;
}

export function digestBudget(home, override) {
  const cfg = loadConfig(home);
  return numFlag(override, cfg.contextBudget ?? DEFAULT_BUDGET);
}

export function budgetFill(home, rel, budget) {
  const chars = liveEntryLines(home, rel).reduce((n, l) => n + l.length, 0);
  return { chars, budget, pct: budget > 0 ? chars / budget : 0 };
}

const text = (line) =>
  line.trim().slice(2).replace(/\s*\[[^\]]*\]\s*$/, '').trim();

// Concrete proposals for one file that is at/over the threshold.
export function consolidationProposals(home, rel, budget, now = Date.now()) {
  const lines = liveEntryLines(home, rel);
  const usage = loadUsage(home);
  const proposals = [];

  // Near-duplicate pairs: keep the stronger entry, delete the weaker.
  const scored = lines.map((l, i) => ({
    l,
    i,
    id: entryId(l),
    s: scoreEntry(l, usage, undefined, now),
  }));
  const paired = new Set();
  for (let i = 0; i < scored.length && proposals.length < MAX_PROPOSALS; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const [a, b] = [scored[i], scored[j]];
      if (paired.has(a.i) || paired.has(b.i) || !a.id || !b.id) continue;
      if (similarity(text(a.l), text(b.l)) < MERGE_SIMILARITY) continue;
      const [keep, drop] = a.s >= b.s ? [a, b] : [b, a];
      proposals.push(
        `merge ${drop.id} into ${keep.id} (near-duplicate): fold any unique detail into ${keep.id}, then \`amr delete ${drop.id}\``
      );
      paired.add(a.i);
      paired.add(b.i);
      break;
    }
  }

  // Entries that should not occupy budget at all.
  for (const { l, i, id } of scored) {
    if (proposals.length >= MAX_PROPOSALS || paired.has(i) || !id) continue;
    if (isExpired(l))
      proposals.push(`expired entry ${id}: \`amr delete ${id}\``);
    else if (entryKind(l) !== 'state' && episodicHits(l).length)
      proposals.push(
        `session-state-looking entry ${id}: \`amr delete ${id}\` or re-save as --kind state`
      );
  }
  return proposals;
}

// True when the file is at/over the consolidation threshold.
export function overThreshold(home, rel, budget) {
  const cfg = loadConfig(home);
  return budgetFill(home, rel, budget).pct >= (cfg.consolidateAt ?? CONSOLIDATE_AT);
}
