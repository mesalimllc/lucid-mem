import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = (s = '') => process.stdout.write(s + '\n');

const home = os.homedir();
const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localappdata =
  process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

// Where each host keeps local session transcripts/summaries.
// Mechanical enumeration only — an agent reads the content.
const SOURCES = [
  {
    host: 'devin',
    roots: [
      path.join(appdata, 'devin', 'cli', 'transcripts'),
      path.join(appdata, 'devin', 'cli', 'summaries'),
    ],
    ext: ['.json', '.jsonl', '.md'],
  },
  {
    host: 'claude',
    roots: [path.join(home, '.claude', 'projects')],
    ext: ['.jsonl', '.json', '.md'],
  },
  {
    host: 'codex',
    roots: [
      path.join(home, '.codex', 'sessions'),
      path.join(home, '.codex', 'archived_sessions'),
    ],
    ext: ['.jsonl', '.json'],
  },
  {
    host: 'cline',
    roots: [
      path.join(home, '.cline', 'tasks'),
      path.join(home, '.cline', 'data'),
    ],
    ext: ['.jsonl', '.json', '.md'],
  },
  {
    host: 'muse',
    roots: [
      path.join(localappdata, 'hermes', 'sessions'),
      path.join(localappdata, 'hermes', 'terminal-sessions'),
    ],
    ext: ['.jsonl', '.json', '.md', ''],
  },
  {
    host: 'copilot',
    roots: [path.join(home, '.copilot', 'chats')],
    ext: ['.json', '.jsonl', '.md', ''],
  },
  {
    host: 'cursor',
    roots: [path.join(home, '.cursor', 'chats')],
    ext: ['.json', '.jsonl', '.md', ''],
  },
];

const MAX_PER_HOST = 100;

// ---------- transcript extraction ----------

const flat = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
    ? c.map((p) => p?.text || p?.input_text || p?.content || '').join(' ')
    : '';
const unwrap = (s) => {
  const m = String(s).match(/^<user_input[^>]*>([\s\S]*)<\/user_input>$/);
  return m ? m[1] : s;
};
const clean = (s) => {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  // Some formats nest the content array as a JSON string.
  if (/^\{\s*"content"/.test(t))
    try {
      t = flat(JSON.parse(t).content) || t;
      t = t.replace(/\s+/g, ' ').trim();
    } catch {}
  return unwrap(t).trim();
};
// System-injected blobs that ride the user role in several formats.
const isJsonBlob = (t) => {
  if (!/^[{[]/.test(t)) return false;
  try {
    return typeof JSON.parse(t) === 'object';
  } catch {
    return false;
  }
};
const isNoise = (t) =>
  !t ||
  isJsonBlob(t) ||
  /^(\[object Object\],?)+$/.test(t) ||
  /^<[a-z_][a-z0-9_-]*[\s>]/.test(t) ||
  /^Title: .*URL: https?:/s.test(t) ||
  /^(# AGENTS\.md|<INSTRUCTIONS>|<environment_context|<command-|<local-command|<system-reminder|Caveat:|This session is being continued)/.test(
    t
  );

const parseJsonl = (p) =>
  fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const parseJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// Each returns an array of {index, text} user messages.
const EXTRACT = {
  claude(p) {
    return parseJsonl(p)
      .filter((j) => j.type === 'user')
      .map((j) => clean(flat(j.message?.content ?? j.content)))
      .filter((t) => !isNoise(t));
  },
  codex(p) {
    return parseJsonl(p)
      .filter(
        (j) => j.payload?.role === 'user' && j.payload?.type === 'message'
      )
      .map((j) => clean(flat(j.payload.content)))
      .filter((t) => !isNoise(t));
  },
  devin(p) {
    const j = parseJson(p);
    return (j?.steps || [])
      .filter((s) => s.source === 'user')
      .map((s) => clean(s.message))
      .filter((t) => !isNoise(t));
  },
  muse(p) {
    const j = parseJson(p);
    const msgs = j?.request?.body?.messages || j?.messages || [];
    return msgs
      .filter((m) => m.role === 'user')
      .map((m) => clean(flat(m.content)))
      .filter((t) => !isNoise(t));
  },
  cline(p) {
    const meta = parseJson(p);
    const mp =
      meta?.messages_path && fs.existsSync(meta.messages_path)
        ? meta.messages_path
        : null;
    const msgs = mp ? parseJson(mp) : meta?.messages;
    const arr = Array.isArray(msgs) ? msgs : msgs?.messages || [];
    const out = arr
      .filter((m) => (m.role || m.type) === 'user')
      .map((m) => clean(flat(m.content ?? m.text)))
      .filter((t) => !isNoise(t));
    if (!out.length && meta?.prompt)
      out.push(clean(meta.prompt.replace(/<[^>]+>/g, ' ')));
    return out;
  },
  generic(p) {
    if (p.endsWith('.jsonl'))
      return parseJsonl(p)
        .filter((j) => (j.role || j.message?.role || j.payload?.role) === 'user')
        .map((j) =>
          clean(flat(j.content ?? j.message?.content ?? j.payload?.content))
        )
        .filter((t) => !isNoise(t));
    const j = parseJson(p);
    const arr = Array.isArray(j) ? j : j?.messages || j?.steps || [];
    return arr
      .filter((m) => (m.role || m.source || m.type) === 'user')
      .map((m) => clean(flat(m.content ?? m.text ?? m.message)))
      .filter((t) => !isNoise(t));
  },
};

const MAX_PER_FILE = 50;

// Enumerate transcript files newer than `since` across all host roots.
export function collectSessions(since) {
  const found = [];
  for (const src of SOURCES) {
    let hostCount = 0;
    for (const root of src.roots) {
      if (!fs.existsSync(root)) continue;
      (function walk(dir) {
        if (hostCount >= MAX_PER_HOST) return;
        let ents;
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (hostCount >= MAX_PER_HOST) return;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (
            e.isFile() &&
            src.ext.includes(path.extname(e.name).toLowerCase())
          ) {
            try {
              const st = fs.statSync(p);
              if (st.mtimeMs >= since) {
                found.push({
                  host: src.host,
                  path: p,
                  mtime: st.mtime.toISOString(),
                  sizeKB: Math.round(st.size / 1024),
                });
                hostCount++;
              }
            } catch {}
          }
        }
      })(root);
    }
  }
  found.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return found;
}

// Normalize found transcript files to their user-message streams.
export function extractMessages(found, { max = 200, min = 15 } = {}) {
  const msgs = [];
  for (const f of found) {
    if (msgs.length >= max) break;
    const ext = EXTRACT[f.host] || EXTRACT.generic;
    let texts = [];
    try {
      texts = ext(f.path).slice(0, MAX_PER_FILE);
    } catch {
      continue;
    }
    const seenText = new Set();
    for (const text of texts) {
      if (seenText.has(text)) continue;
      seenText.add(text);
      if (msgs.length >= max) break;
      if (text.length < min) continue;
      msgs.push({ host: f.host, file: f.path, mtime: f.mtime, text });
    }
  }
  return msgs;
}

export function cmdHarvest(flags) {
  const days = parseInt(flags.days ?? '7', 10);
  const since = flags.since
    ? new Date(flags.since).getTime()
    : Date.now() - days * 864e5;
  const found = collectSessions(since);

  // --extract: normalize each file to its user-message stream.
  // Bounded: --max messages total (default 200), 500 chars each.
  if (flags.extract) {
    const max = parseInt(flags.max || '200', 10);
    const min = parseInt(flags.min || '15', 10);
    const msgs = extractMessages(found, { max, min });
    if (flags.json) return out(JSON.stringify(msgs, null, 2));
    for (const m of msgs)
      out(
        `[${m.host}] ${m.mtime.slice(0, 10)} ${m.text.slice(0, 500)}`
      );
    out(`\n${msgs.length} user message(s) extracted`);
    return;
  }

  if (flags.json) return out(JSON.stringify(found, null, 2));
  if (!found.length)
    return out(`no transcripts found newer than ${days}d`);
  out(`${found.length} transcript(s) newer than ${days}d:`);
  for (const f of found)
    out(`  [${f.host}] ${f.mtime.slice(0, 10)} ${f.sizeKB}KB  ${f.path}`);
}
