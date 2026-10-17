import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { numFlag } from './core.mjs';

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
  {
    host: 'commandcode',
    roots: [path.join(home, '.commandcode', 'projects')],
    ext: ['.jsonl', '.json'],
  },
  {
    host: 'freebuff',
    // Shared codebuff-family session dir (codebuff/manicode/freebuff
    // all log chats here); ~/.freebuff/worktrees has no transcripts.
    roots: [
      path.join(home, '.config', 'manicode', 'projects'),
      path.join(home, '.freebuff', 'worktrees'),
    ],
    ext: ['.jsonl', '.json'],
  },
  {
    host: 'opencode',
    roots: [
      path.join(home, '.local', 'share', 'opencode'),
      path.join(localappdata, 'opencode'),
    ],
    ext: ['.db'],
    match: /^opencode\.db$/i,
  },
  {
    host: 'antigravity',
    roots: [path.join(home, '.gemini', 'antigravity', 'conversations')],
    ext: ['.db'],
  },
  // windsurf: Cascade keeps conversations in protobuf/leveldb under
  // %APPDATA%/Windsurf and embedding blobs under ~/.codeium/database;
  // no user-message transcript store to harvest.
];

// node:sqlite is built in from Node 22.5; DB sources degrade silently
// on older runtimes (file-based hosts keep working). Lazy require so
// the ExperimentalWarning never pollutes non-harvest invocations.
let DatabaseSync;
const loadSqlite = () => {
  if (DatabaseSync !== undefined) return DatabaseSync;
  try {
    DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
};

const openDb = (p) => {
  const DS = loadSqlite();
  if (!DS) return null;
  try {
    return new DS(p, { readOnly: true });
  } catch {
    return null;
  }
};

// Antigravity step payloads are protobuf serialized as {"0":byte,...}.
// step_type 14 is the user message; pull printable runs out of the
// bytes and drop ID-shaped strings (uuids, base64url tokens).
const agyUserText = (payload) => {
  let buf;
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    buf = Buffer.from(payload);
  } else {
    let obj;
    try {
      obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      return '';
    }
    if (!obj || typeof obj !== 'object') return '';
    buf = Buffer.from(Object.values(obj));
  }
  const text = buf.toString('utf8');
  const runs =
    text.match(/[ -~\u00a0-\u2fff\ue000-\ufffc]{15,}/g) || [];
  // Keep prose runs: several words, mostly letters, little punctuation
  // junk, no filename dumps or injected <TAG> blobs. The protobuf echoes
  // the user string twice inside one payload; collapse the repeat.
  const JUNK = /[-_$/\\*{}<>="#|~`@^[\]]/g;
  const seen = new Set();
  const kept = [];
  for (const raw of runs) {
    let t = raw
      .trim()
      .replace(/^[^\w<]+/, '')
      .replace(/^[A-Z](?=[A-Z][a-z])/, '');
    for (let len = t.length >> 1; len >= 15; len--) {
      const i = t.indexOf(t.slice(0, len), 1);
      if (i > 0) {
        t = t.slice(0, i).replace(/\s+\S{1,4}["']?$/, '').trim();
        break;
      }
    }
    t = t.replace(/["'\s]+$/, '').trim();
    if (t.split(/\s+/).filter(Boolean).length < 3) continue;
    if (!/[a-z]/.test(t)) continue;
    if (/^<[A-Za-z_][A-Za-z0-9_-]*[\s>]/.test(t)) continue;
    if (/\.(png|jpe?g|gif|webp|exe|dll|db|md|json|log)\b/i.test(t))
      continue;
    if ((t.match(/[A-Za-z]/g) || []).length / t.length < 0.5) continue;
    if ((t.match(JUNK) || []).length / t.length > 0.3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  return kept.join(' ');
};

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
  /^(\[object Object\][,\s]*)+$/.test(t) ||
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
  // opencode keeps sessions in drizzle sqlite: message.data.role +
  // part.data joined on message_id; text parts carry user prose.
  opencode(p, since = 0) {
    const db = openDb(p);
    if (!db) return [];
    try {
      return db
        .prepare(
          `select p.data d from part p
           join message m on p.message_id = m.id
           where json_extract(m.data,'$.role') = 'user'
             and json_extract(p.data,'$.type') = 'text'
             and m.time_created >= ?
           order by m.time_created`
        )
        .all(since)
        .map((r) => clean(JSON.parse(r.d).text))
        .filter((t) => !isNoise(t));
    } catch {
      return [];
    } finally {
      db.close();
    }
  },
  // antigravity stores one sqlite trajectory db per conversation;
  // steps.step_type 14 rows carry the user prompt as protobuf bytes.
  antigravity(p) {
    const db = openDb(p);
    if (!db) return [];
    try {
      return db
        .prepare('select step_payload from steps where step_type = 14')
        .all()
        .map((r) => clean(agyUserText(r.step_payload)))
        .filter((t) => !isNoise(t));
    } catch {
      return [];
    } finally {
      db.close();
    }
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
            src.ext.includes(path.extname(e.name).toLowerCase()) &&
            (!src.match || src.match.test(e.name))
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
export function extractMessages(
  found,
  { max = 200, min = 15, since = 0 } = {}
) {
  const msgs = [];
  for (const f of found) {
    if (msgs.length >= max) break;
    const ext = EXTRACT[f.host] || EXTRACT.generic;
    let texts = [];
    try {
      texts = ext(f.path, since).slice(0, MAX_PER_FILE);
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
  const days = numFlag(flags.days ?? '7', 7);
  const since = flags.since
    ? new Date(flags.since).getTime()
    : Date.now() - days * 864e5;
  const found = collectSessions(since);

  // --extract: normalize each file to its user-message stream.
  // Bounded: --max messages total (default 200), 500 chars each.
  if (flags.extract) {
    const max = numFlag(flags.max || '200', 200);
    const min = numFlag(flags.min || '15', 15);
    const msgs = extractMessages(found, { max, min, since });
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
