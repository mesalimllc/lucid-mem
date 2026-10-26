// Failure-triggered recall: given a tool error, surface the one memory
// entry most likely to fix it, at the moment it matters, instead of
// hoping the agent spots it in the session-start dump. Deterministic
// only: error-code/keyword triggers plus token overlap against live
// entries (archive/ and dreams/ never fire). Silent when nothing
// clears the bar, because a recall hook that cries wolf gets ignored.

import fs from 'node:fs';
import path from 'node:path';
import { ensureRepo, entryKind, isExpired } from './core.mjs';
import { entryId } from './ids.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

// Known error shapes and the vocabulary of the entries that fix them.
// First entries: shell heredocs mangling escapes (CS1010 from C#
// string literals, shell EOF, Python SyntaxError) and cp1252 decoding.
const TRIGGERS = [
  { re: /cs1010|newline in constant/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /unexpected eof while looking for matching|unexpected end of file/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /syntaxerror/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /unicodedecodeerror|cp1252|codec can't decode|charmap/i, terms: ['cp1252', 'encoding', 'utf-8', 'utf8'] },
];

const STOP = new Set([
  'error', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'file',
  'line', 'failed', 'failure', 'exception', 'traceback', 'most', 'recent',
  'last', 'call', 'exit', 'code', 'status',
]);

const tokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );

const looksLikeError = (text) =>
  /\b(error|failed|failure|exception|traceback|syntaxerror|unexpected eof)\b|\b[a-z]{2}\d{4}\b|\bexit code [1-9]/i.test(
    text
  );

function liveEntries(home) {
  const entries = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(home, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (rel !== 'archive' && rel !== 'dreams') walk(p);
      } else if (e.name.endsWith('.md')) {
        for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/))
          if (l.trim().startsWith('- ') && !l.includes('[[') && !isExpired(l))
            entries.push(l);
      }
    }
  })(home);
  return entries;
}

export function findRecall(home, errorText, limit = 3) {
  if (!errorText || !looksLikeError(errorText)) return [];
  const errTokens = tokens(errorText);
  const lower = errorText.toLowerCase();
  const triggerTerms = TRIGGERS.filter((t) => t.re.test(errorText)).flatMap(
    (t) => t.terms
  );
  const scored = [];
  for (const line of liveEntries(home)) {
    const text = line.toLowerCase();
    let score = 0;
    for (const w of tokens(line)) if (errTokens.has(w)) score += 1;
    for (const term of triggerTerms) if (text.includes(term)) score += 4;
    if (entryKind(line) === 'pitfall') score += 0.5;
    if (score >= 4) scored.push({ line, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.line);
}

// Flatten a hook payload's tool output into searchable text.
function payloadText(payload) {
  const parts = [];
  (function collect(v) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  })(payload?.tool_response ?? payload?.tool_result ?? payload?.tool_output ?? payload);
  return parts.join('\n');
}

export function cmdRecall(text, flags) {
  const home = ensureRepo();
  let errorText = text || '';
  let payload = null;
  if (flags.hook || !errorText) {
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch {}
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
        errorText = payloadText(payload);
      } catch {
        errorText = raw;
      }
    }
  }
  const hits = findRecall(home, errorText);
  if (!hits.length) return;
  if (flags.hook) {
    out(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Relevant memory for this error (from \`amr recall\`):\n${hits.join('\n')}`,
        },
      })
    );
    return;
  }
  for (const h of hits) {
    const id = entryId(h);
    out(id ? `${h} [recall id: ${id}]` : h);
  }
}
