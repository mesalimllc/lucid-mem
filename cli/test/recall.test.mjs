import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, tmpdir } from './helpers.mjs';

const PITFALL =
  'When writing files through a bash heredoc on Windows, build backslash escapes with chr(92), because heredoc escapes corrupt string literals';

function seed(home) {
  run(['ensure'], { amrHome: home });
  const a = run(['add', PITFALL, '--kind', 'pitfall'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  return a.stdout.match(/\[id ([0-9a-f]{4})\]/)?.[1];
}

test('recall surfaces the heredoc pitfall on CS1010', () => {
  const home = tmpdir();
  const id = seed(home);
  const r = run(['recall', 'error CS1010: Newline in constant'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chr\(92\)/);
  assert.match(r.stdout, new RegExp(id));
});

test('recall surfaces the heredoc pitfall on shell heredoc EOF errors', () => {
  const home = tmpdir();
  seed(home);
  const r = run(['recall', "bash: unexpected EOF while looking for matching `''"], { amrHome: home });
  assert.match(r.stdout, /chr\(92\)/);
});

test('recall stays silent for unrelated errors and for non-error output', () => {
  const home = tmpdir();
  seed(home);
  const miss = run(['recall', 'error TS2304: Cannot find name frobnicate'], { amrHome: home });
  assert.equal(miss.stdout.trim(), '');
  const ok = run(['recall', 'build succeeded, 0 errors'], { amrHome: home });
  assert.equal(ok.stdout.trim(), '');
});

test('recall --hook reads a PostToolUse payload and emits additionalContext JSON only on a match', () => {
  const home = tmpdir();
  seed(home);
  const payload = JSON.stringify({
    session_id: 's1',
    tool_name: 'Bash',
    tool_response: { stderr: 'error CS1010: Newline in constant', exit_code: 1 },
  });
  const r = run(['recall', '--hook'], { amrHome: home, input: payload });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /chr\(92\)/);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');

  const quiet = run(['recall', '--hook'], {
    amrHome: home,
    input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_response: { stdout: 'all good' } }),
  });
  assert.equal(quiet.stdout.trim(), '');
});
