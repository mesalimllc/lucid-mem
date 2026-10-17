// Optional LLM judge layer for `amr coverage --judge`. The deterministic
// pass stays the gate; a judge only refines the small candidate set.
// Backends are host CLIs already installed and authed — no API keys in
// the repo. Prompt goes on stdin, verdict JSON comes back on stdout (or
// codex's --output-last-message file).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 180_000;

const BACKENDS = {
  claude: {
    bin: 'claude',
    // --strict-mcp-config with an empty config skips MCP init,
    // --model haiku is plenty for classification, --max-turns 1 keeps
    // it to a single answer.
    args: () => [
      '-p',
      '--output-format',
      'json',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--model',
      'haiku',
      '--max-turns',
      '1',
    ],
    extract: (r) => {
      try {
        const j = JSON.parse(r.stdout);
        // -p --output-format json emits an array of events (init,
        // assistant…, result) on newer versions, a single result
        // object on older ones.
        const ev = Array.isArray(j)
          ? j.findLast((e) => e?.type === 'result')
          : j;
        return ev?.result || null;
      } catch {
        return r.stdout; // plain-text output
      }
    },
  },
  codex: {
    bin: 'codex',
    args: (outFile) => [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--output-last-message',
      outFile,
      '-',
    ],
    extract: (r, outFile) =>
      fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null,
  },
  // Generic escape hatch: any command taking the prompt on stdin and
  // answering JSON on stdout. Doubles as the test hook.
  env: {
    bin: null,
    args: () => [],
    extract: (r) => r.stdout,
  },
};

export function resolveJudge(which) {
  const want = which === true || which === 'auto' ? null : String(which);
  if (want && !(want in BACKENDS)) return null;
  const order = want ? [want] : ['claude', 'codex', 'env'];
  for (const name of order) {
    if (name === 'env' ? !!process.env.AMR_JUDGE_CMD : findBin(BACKENDS[name].bin))
      return name;
  }
  return null;
}

function findBin(name) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(tool, [name], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return null;
  const paths = r.stdout.split(/\r?\n/).filter(Boolean);
  // Prefer a real .exe over .cmd shims — batch files need a shell.
  return (
    paths.find((p) => /\.exe$/i.test(p.trim())) || paths[0] || ''
  ).trim();
}

// Returns the judge's raw reply text, or null on any failure. The caller
// falls back to the deterministic result — judging must never break a
// coverage run.
export function runJudge(name, prompt) {
  const b = BACKENDS[name];
  if (!b) return null;
  const outFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'amr-judge-')),
    'out.txt'
  );
  let r;
  try {
    const opts = {
      input: prompt,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      // Neutral cwd: the judge mustn't load whatever project coverage
      // was run from. AMR_NO_JUDGE stops recursion into another judge;
      // AMR_HOOKS_OFF no-ops amr's own hook subcommands inside the
      // spawned session (they'd run sync/dream/coverage on exit).
      cwd: os.tmpdir(),
      env: { ...process.env, AMR_NO_JUDGE: '1', AMR_HOOKS_OFF: '1' },
    };
    if (name === 'env')
      r = spawnSync(process.env.AMR_JUDGE_CMD, { ...opts, shell: true });
    else {
      const bin = findBin(b.bin);
      if (!bin) return null;
      const isBatch = /\.(cmd|bat)$/i.test(bin);
      r = spawnSync(
        isBatch ? 'cmd.exe' : bin,
        isBatch
          ? ['/d', '/s', '/c', `"${bin}"`, ...b.args(outFile)]
          : b.args(outFile),
        opts
      );
    }
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;
  try {
    const text = b.extract(r, outFile);
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}
