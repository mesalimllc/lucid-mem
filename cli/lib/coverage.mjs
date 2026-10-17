import fs from 'node:fs';
import path from 'node:path';
import { commit, ensureRepo, numFlag, withLock } from './core.mjs';
import { collectSessions, extractMessages } from './harvest.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

// What "should have been saved" looks like in a user message: durable
// preferences, decisions, confirmations, and root-cause findings.
// STRONG markers alone qualify; WEAK markers only in short messages
// (long dumps happen to contain them by accident).
const STRONG =
  /\b(prefer|always|never|remember|note that|decided|instead of|rather than|default to|don['’]?t use|do not use|we use|sticking with|confirmed|turns out|workaround|the fix was|root cause|deprecated)\b/i;
const WEAK = /\b(shipped|released|pinned|going with)\b/i;

// Non-user prose that rides the user role in transcripts: tool errors,
// context summaries, file/code dumps, listings, test output, diffs,
// annotations, agent-monologue steps (antigravity mixes them into the
// user slot).
const DUMP =
  /^(error:|context summary|#|```|\{|\[|\/|\d+\s|\d+[:|]|[-\w./]+ total \d+|total \d+ |diff |--- |@@ |index |[MDAR] \S+\.\w+|response annotations|base directory)/i;
const heavyMarkup = (t) =>
  (t.match(/[{}"|#*<>_=[\]\\`]/g) || []).length / t.length > 0.12;
const FILE_REFS =
  /\b[\w.-]+\.(?:go|tsx?|mjs|jsx?|cs|json|ya?ml|py|rs|cpp|c|h|png|jpe?g|dll|exe|log|toml|sql|ps1|sh)\b/g;
// Source-code density: several of () ; {} // => == ++ --- is a paste
// of code, not a user statement.
const isCodey = (t) =>
  (t.match(/[{}();]|\/\/|=>|={2,}|[+-]{3,}/g) || []).length >= 4;
const isDump = (t) =>
  DUMP.test(t) ||
  heavyMarkup(t) ||
  isCodey(t) ||
  /[drwx-]{10}/.test(t) ||
  /(\d+ (files?|tests?) (passed|failed))|passed \(\d+\)|RUN v\d|✓/.test(t) ||
  /^(the user (is|asked|wants)|we (need|should|can|must|will)\b)/i.test(t) ||
  (t.match(FILE_REFS) || []).length >= 3;
const isDurable = (t) =>
  !isDump(t) &&
  (STRONG.test(t) || (t.length < 200 && WEAK.test(t)));

const STOP = new Set(
  'the a an and or but with this that from into your you for are was were have has been not all can will would could should about when what which there their they them then than also just like over under more some any each other such only very make made does done here need want keep lets'.split(
    ' '
  )
);

// Most distinctive terms first: code tokens and long words carry the
// signal that a memory entry would share.
const terms = (text) =>
  [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_.\/-]+/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w))
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);

const normWords = (t) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.\/-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

const corpusText = (home) => {
  const parts = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md'))
        parts.push(normWords(fs.readFileSync(p, 'utf8')).join(' '));
    }
  })(home);
  return ` ${parts.join(' ')} `;
};

// A durable signal counts as covered when a 4-word run of its content
// appears verbatim in the corpus (near-verbatim save), or when ≥35% of
// its distinctive terms appear (paraphrased save). Term hits are
// prefix-aware at 6 chars so prefer matches prefers/preference.
const covered = (text, corpus) => {
  const content = normWords(text).filter(
    (w) => w.length >= 4 && !STOP.has(w)
  );
  for (let i = 0; i + 4 <= content.length; i++)
    if (corpus.includes(` ${content.slice(i, i + 4).join(' ')} `))
      return true;
  const t = terms(text);
  if (!t.length) return false;
  const hit = (w) =>
    corpus.includes(` ${w} `) ||
    corpus.includes(` ${w.slice(0, Math.min(6, w.length))}`);
  const hits = t.filter(hit).length;
  return hits / t.length >= 0.35;
};

export function cmdCoverage(flags) {
  const home = ensureRepo();
  const days = numFlag(flags.days ?? '7', 7);
  const since = flags.since
    ? new Date(flags.since).getTime()
    : Date.now() - days * 864e5;
  const max = numFlag(flags.max || '400', 400);

  const found = collectSessions(since);
  const msgs = extractMessages(found, { max, since });
  const corpus = corpusText(home);

  const seen = new Set();
  const durable = [];
  for (const m of msgs) {
    const key = m.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key) || !isDurable(m.text)) continue;
    seen.add(key);
    durable.push({ ...m, covered: covered(m.text, corpus) });
  }

  const hits = durable.filter((d) => d.covered).length;
  const missed = durable.filter((d) => !d.covered);
  const rate = durable.length ? Math.round((hits / durable.length) * 100) : null;

  if (flags.json)
    return out(
      JSON.stringify(
        {
          days,
          transcripts: found.length,
          messages: msgs.length,
          durable: durable.length,
          covered: hits,
          rate,
          missed: missed.map((m) => ({
            host: m.host,
            date: m.mtime.slice(0, 10),
            text: m.text.slice(0, 300),
          })),
        },
        null,
        2
      )
    );

  if (!durable.length)
    return out(`no durable signals found in ${found.length} transcript(s), ${days}d`);
  out(
    `coverage (${days}d): ${hits}/${durable.length} durable signals covered — save rate ${rate}%`
  );
  if (missed.length) {
    out('missed:');
    for (const m of missed.slice(0, 20))
      out(`  [${m.host}] ${m.mtime.slice(0, 10)} ${m.text.slice(0, 140)}`);
    if (missed.length > 20) out(`  … +${missed.length - 20} more`);
  }
  out(
    'note: user-stated signals only; facts the agent learned silently are not observable from transcripts'
  );

  // Trend line: append this run so the metric has history.
  if (!flags['no-log']) {
    const log = path.join(home, 'dreams', 'coverage.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      days,
      durable: durable.length,
      covered: hits,
      rate,
    };
    withLock(home, () => {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, JSON.stringify(entry) + '\n');
      commit(home, ['dreams/coverage.jsonl'], `Coverage ${rate}% (${hits}/${durable.length})`);
    });
  }
}
