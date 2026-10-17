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

export function cmdHarvest(flags) {
  const days = parseInt(flags.days ?? '7', 10);
  const since = flags.since
    ? new Date(flags.since).getTime()
    : Date.now() - days * 864e5;
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

  if (flags.json) return out(JSON.stringify(found, null, 2));
  if (!found.length)
    return out(`no transcripts found newer than ${days}d`);
  out(`${found.length} transcript(s) newer than ${days}d:`);
  for (const f of found)
    out(`  [${f.host}] ${f.mtime.slice(0, 10)} ${f.sizeKB}KB  ${f.path}`);
}
