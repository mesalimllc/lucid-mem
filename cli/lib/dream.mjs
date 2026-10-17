import fs from 'node:fs';
import path from 'node:path';
import {
  commit,
  ensureRepo,
  git,
} from './core.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

const bulletText = (line) =>
  line
    .trim()
    .replace(/^-\s*/, '')
    .replace(/(\s*\[[^\]]*\])+\s*$/, '')
    .trim()
    .toLowerCase();

const metaDate = (line) => {
  const dates = [...line.matchAll(/(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1])
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
};

function mdFiles(home) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md'))
        files.push(path.relative(home, p).replace(/\\/g, '/'));
    }
  })(home);
  return files.sort();
}

function collect(home) {
  const entries = [];
  const indexLinks = new Set();
  for (const rel of mdFiles(home)) {
    const lines = fs
      .readFileSync(path.join(home, rel), 'utf8')
      .split(/\r?\n/);
    let inIndex = false;
    lines.forEach((l, i) => {
      if (/^##\s+Index/.test(l)) inIndex = true;
      else if (/^#{1,2}\s/.test(l) && !/^##\s+Index/.test(l)) inIndex = false;
      const link = l.match(/^-\s*\[\[([^\]]+)\]\]/);
      if (link) {
        if (rel === 'MEMORY.md' && inIndex) indexLinks.add(link[1]);
        return;
      }
      if (!l.trim().startsWith('- ')) return;
      entries.push({
        file: rel,
        line: i,
        raw: l,
        norm: bulletText(l),
        date: metaDate(l),
        archived: rel.startsWith('archive/'),
      });
    });
  }
  return { entries, indexLinks };
}

export function analyze(home, { staleDays = 90 } = {}) {
  const { entries, indexLinks } = collect(home);
  const files = mdFiles(home).filter((f) => f !== 'MEMORY.md');
  const cutoff = new Date(Date.now() - staleDays * 864e5)
    .toISOString()
    .slice(0, 10);

  const byNorm = new Map();
  for (const e of entries)
    byNorm.set(e.norm, [...(byNorm.get(e.norm) || []), e]);
  const exactDups = [...byNorm.values()].filter((g) => g.length > 1);

  const possibleDups = [];
  const uniq = [...byNorm.keys()];
  for (let i = 0; i < uniq.length; i++)
    for (let j = i + 1; j < uniq.length; j++) {
      const [a, b] = [uniq[i], uniq[j]];
      if (a.length > 15 && b.length > 15 && (a.includes(b) || b.includes(a)))
        possibleDups.push([byNorm.get(a)[0], byNorm.get(b)[0]]);
    }

  const stale = entries.filter(
    (e) => !e.archived && e.date && e.date < cutoff
  );
  const noDate = entries.filter((e) => !e.archived && !e.date).length;

  const filesNoExt = files.map((f) => f.replace(/\.md$/, ''));
  const liveNoExt = filesNoExt.filter((f) => !f.startsWith('archive/'));
  const deadLinks = [...indexLinks].filter(
    (l) => !filesNoExt.includes(l)
  );
  const unindexed = liveNoExt.filter((f) => ![...indexLinks].includes(f));

  const mem = path.join(home, 'MEMORY.md');
  const memLines = fs.existsSync(mem)
    ? fs.readFileSync(mem, 'utf8').split(/\r?\n/)
    : [];
  const memBytes = fs.existsSync(mem) ? fs.statSync(mem).size : 0;

  const dirty = git(home, ['status', '--porcelain']).stdout;

  return {
    repo: home,
    stats: {
      files: mdFiles(home).length,
      entries: entries.length,
      memoryMdBytes: memBytes,
      memoryMdLines: memLines.length,
      dirtyFiles: dirty ? dirty.split('\n').length : 0,
    },
    exactDups: exactDups.map((g) =>
      g.map((e) => `${e.file}:${e.line + 1}`)
    ),
    possibleDups: possibleDups.map(([a, b]) => [
      `${a.file}:${a.line + 1}`,
      `${b.file}:${b.line + 1}`,
    ]),
    stale: stale.map(
      (e) => `${e.file}:${e.line + 1} (last: ${e.date})`
    ),
    entriesWithoutDate: noDate,
    deadIndexLinks: deadLinks,
    unindexedFiles: unindexed,
  };
}

function lastDreamAt(home) {
  const stamp = path.join(home, '.git', 'amr.lastdream');
  if (fs.existsSync(stamp)) return fs.statSync(stamp).mtimeMs;
  const log = git(home, ['log', '-1', '--format=%ct', '--grep=^Dream:']);
  return log.code === 0 && log.stdout ? parseInt(log.stdout, 10) * 1000 : 0;
}

function touchDream(home) {
  fs.writeFileSync(
    path.join(home, '.git', 'amr.lastdream'),
    new Date().toISOString()
  );
}

export function cmdDream(flags) {
  const home = ensureRepo();
  const staleDays = parseInt(flags.days ?? '90', 10);

  // --if-stale N: run only when the last dream is older than N days
  if (flags['if-stale'] !== undefined) {
    const minAge = parseInt(flags['if-stale'] || '7', 10);
    const ageDays = (Date.now() - lastDreamAt(home)) / 864e5;
    if (ageDays < minAge) return; // recently dreamt; stay quiet (hook-safe)
  }

  const report = analyze(home, { staleDays });

  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return;
  }

  const s = report.stats;
  out(`dream report — ${home}`);
  out(`  ${s.entries} entries in ${s.files} file(s); MEMORY.md ${s.memoryMdBytes}B/${s.memoryMdLines} lines`);
  if (s.memoryMdBytes > 3072)
    out(`  ! MEMORY.md is large — move detail into topic files`);
  if (s.dirtyFiles) out(`  ! ${s.dirtyFiles} uncommitted change(s) present`);
  out(`  exact duplicates   : ${report.exactDups.length}`);
  report.exactDups.forEach((g) => out(`    - ${g.join('  AND  ')}`));
  out(`  possible duplicates: ${report.possibleDups.length}`);
  report.possibleDups.forEach(([a, b]) => out(`    - ${a}  ~  ${b}`));
  out(`  stale (>${staleDays}d)      : ${report.stale.length}`);
  report.stale.forEach((e) => out(`    - ${e}`));
  out(`  dead index links   : ${report.deadIndexLinks.length}`);
  report.deadIndexLinks.forEach((l) => out(`    - [[${l}]]`));
  out(`  unindexed files    : ${report.unindexedFiles.length}`);
  report.unindexedFiles.forEach((f) => out(`    - ${f}`));
  if (report.entriesWithoutDate)
    out(`  entries missing 'added:' date: ${report.entriesWithoutDate}`);

  if (!flags.fix && !flags.compact) {
    touchDream(home);
    out('');
    out('run `amr dream --fix` for mechanical cleanup (index, dead links, exact dups); add --compact to archive entries beyond the digest cap. Semantic merging needs an agent — see dreams/DREAMER.md');
    return;
  }

  const changed = [];
  const touched = new Set();

  // drop exact-duplicate bullets, keeping the first occurrence
  const seen = new Set();
  for (const rel of mdFiles(home)) {
    const abs = path.join(home, rel);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const keep = [];
    let removed = 0;
    for (const l of lines) {
      if (l.trim().startsWith('- ') && !l.includes('[[')) {
        const n = bulletText(l);
        if (seen.has(n)) {
          removed++;
          continue;
        }
        seen.add(n);
      }
      keep.push(l);
    }
    if (removed) {
      fs.writeFileSync(abs, keep.join('\n').replace(/\n{3,}/g, '\n\n'));
      touched.add(rel);
      changed.push(`${rel}: removed ${removed} duplicate(s)`);
    }
  }

  // prune dead index links + index unindexed files
  const memPath = path.join(home, 'MEMORY.md');
  let memLines = fs.readFileSync(memPath, 'utf8').split(/\r?\n/);
  const pruned = memLines.filter((l) => {
    const m = l.match(/^-\s*\[\[([^\]]+)\]\]/);
    return !m || !report.deadIndexLinks.includes(m[1]);
  });
  if (pruned.length !== memLines.length) {
    changed.push(`pruned ${memLines.length - pruned.length} dead link(s)`);
    memLines = pruned;
    touched.add('MEMORY.md');
  }
  if (report.unindexedFiles.length) {
    let idx = memLines.findIndex((l) => /^##\s+Index/.test(l));
    if (idx < 0) {
      memLines.push('', '## Index');
      idx = memLines.length - 1;
    }
    let ins = idx + 1;
    while (ins < memLines.length && /^-\s*\[\[/.test(memLines[ins].trim()))
      ins++;
    memLines.splice(
      ins,
      0,
      ...report.unindexedFiles.map((f) => `- [[${f}]]`)
    );
    touched.add('MEMORY.md');
    changed.push(`indexed ${report.unindexedFiles.length} file(s)`);
  }
  if (touched.has('MEMORY.md'))
    fs.writeFileSync(memPath, memLines.join('\n').replace(/\n{3,}/g, '\n\n'));

  // --compact: archive oldest entries beyond the digest cap so live
  // files never exceed what `amr context` injects. Archive files stay
  // searchable via `amr search`; they are not session-injected.
  if (flags.compact) {
    const keep = parseInt(flags.keep || '25', 10);
    const pdir = path.join(home, 'projects');
    const targets = [
      'MEMORY.md',
      ...(fs.existsSync(pdir)
        ? fs
            .readdirSync(pdir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => `projects/${e.name}`)
        : []),
    ];
    for (const rel of targets) {
      const abs = path.join(home, rel);
      if (!fs.existsSync(abs)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      const idxAt =
        rel === 'MEMORY.md'
          ? lines.findIndex((l) => /^##\s+Index/.test(l))
          : -1;
      const headEnd = idxAt >= 0 ? idxAt : lines.length;
      const bulletIdx = [];
      for (let i = 0; i < headEnd; i++)
        if (lines[i].trim().startsWith('- ') && !lines[i].includes('[['))
          bulletIdx.push(i);
      if (bulletIdx.length <= keep) continue;
      const move = new Set(bulletIdx.slice(0, bulletIdx.length - keep));
      const archived = [...move]
        .sort((a, b) => a - b)
        .map((i) => lines[i]);
      const arel =
        rel === 'MEMORY.md' ? 'archive/MEMORY.md' : `archive/${rel}`;
      const aabs = path.join(home, arel);
      if (!fs.existsSync(aabs)) {
        fs.mkdirSync(path.dirname(aabs), { recursive: true });
        fs.writeFileSync(aabs, `# Archive: ${rel}\n\n`);
      }
      fs.appendFileSync(aabs, archived.join('\n') + '\n');
      fs.writeFileSync(
        abs,
        lines
          .filter((_, i) => !move.has(i))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
      );
      touched.add(rel);
      touched.add(arel);
      changed.push(`${rel}: archived ${archived.length} oldest entrie(s)`);
    }
  }

  touchDream(home);
  if (!changed.length) return out('nothing mechanical to fix');
  commit(home, [...touched], 'Dream: mechanical cleanup');
  changed.forEach((c) => out(`  ${c}`));
}
