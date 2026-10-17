# Agent Memory Harness — Plan

Turn the Agent Memory Repo spec into an **autonomous** memory layer: agents save and
retrieve memory across sessions and across multiple project repos, with no manual
invocation. This document is the plan; the implementation lives in `cli/` (the `amr`
CLI) and `adapters/` (per-host wiring).

## Core design insight

The two directions of memory need different mechanisms:

- **Retrieve is deterministic.** Session-start hooks run `amr context` and inject the
  memory digest into context. Guaranteed — no model judgment involved.
- **Save is judgment-based.** A hook cannot decide what is durable. Save autonomy =
  an always-on rule block in every host + the retrieved context itself carrying a
  one-line `amr add "..."` affordance. The agent decides *whether*, the CLI makes it
  one trivial command. Anything claiming fully automatic semantic saving is either
  dumping transcripts into git or guessing.

Safety net for missed saves: a `stop`/`sessionEnd` hook commits any dirty files that
`amr` itself owns, and Dreaming (phase 4) consolidates later.

## Verified environment facts (this machine, 2026-10-17)

- `~/.cursor/hooks.json` — real hook API already in use: `sessionStart`,
  `sessionEnd`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `preCompact`,
  `subagentStart/Stop`, `afterFileEdit`, `preToolUse`, `postToolUse`,
  `afterShellExecution`, `afterMCPExecution`. Format:
  `{ "hooks": { "<event>": [{ "command": "..." }] }, "version": 1 }`.
  **Must merge, never clobber** (Weave + Google Cloud hooks already live there).
- `~/.codeium/windsurf/hooks.json` — exists but empty (0 bytes). Event names unverified.
- `~/.claude/settings.json` — standard Claude Code hook schema supported.
- `~/AppData/Roaming/devin/` — Devin CLI. Plugins are skills+metadata only
  (agent-plugins.org schema; no hook declarations found in plugin cache). Devin
  settings support hooks per CLI docs, exact config key unverified. Verified entry
  point: `~/AppData/Roaming/devin/AGENTS.md`, already uses
  `<!-- context7 -->...<!-- context7 -->` marker-delimited blocks.
- `~/.copilot/AGENTS.md` — exists; Copilot CLI reads it.
- Node v22.16, Python 3.13 (uv), Go 1.27 all present.
- Memory repo default: `~/agent-memory` (created 2026-10-17, has trial entry).
- Hindsight rule was removed from Devin AGENTS.md per user request — this harness
  replaces that role.

## Architecture

```
agentmemoryrepo/                     (this fork; upstream = spec repo)
  SPEC.md, README.md                 upstream-synced, untouched
  cli/                               amr — zero-dependency Node CLI (npm bin)
    package.json
    amr.mjs                          entry + dispatch + help
    lib/core.mjs                     repo/git/slug/lock/secrets/entry-edit helpers
    lib/commands.mjs                 ensure, context, add, update, search, index,
                                     remote, sync, doctor
    lib/install.mjs                  per-host adapter writer (merge + backup)
  adapters/shared/rule-block.md      canonical always-on instruction block
  skills/agent-memory-repo/SKILL.md  rewritten later: autonomous layer = default;
                                     skill = manual ops fallback
  agentmemoryharness-plan.md         this file
```

## `amr` CLI spec

Non-negotiables: never interactive, bounded timeouts, exit 0 on soft failure — a
hook must never break or hang a session. Repo location: `$AMR_HOME`, default
`~/agent-memory`.

| Command | Behavior |
|---|---|
| `amr ensure` | Idempotent init: `git init`, `MEMORY.md` (`# Memory` + `## Index`), first commit. Refuses non-empty non-repo dir. Sets repo-local git identity only if none configured (never touches global). |
| `amr context [dir]` | Session-start entry point. Prints `<agent-memory>` digest: global `MEMORY.md` bullets + `projects/<slug>.md` for dir's repo + `## Index` links + save-affordance trailer. If remote configured: `git pull --ff-only` w/ 2s timeout, silent on failure. |
| `amr add "text"` | Append `- text [added: DATE; kind: K; project: P]`. Flags: `--file topic`, `--project` (routes to `projects/<slug>.md`), `--kind`, `--cwd`, `--allow-secret`. Refuses secret-shaped text. Near-dup skip. Auto-indexes new files. Lockfile `.git/amr.lock` (stale >60s broken). Commit + push-if-remote. |
| `amr update "match" "text"` | Replace matching bullet in place (keeps metadata, sets `updated:`). Errors on 0 or >1 matches. |
| `amr search "term"` | `git grep -n -i` inside repo. |
| `amr index` | Rebuild `## Index` from `*.md` files on disk, sorted. |
| `amr remote set <url>` | `git remote set-url origin`. Prints private-repo reminder. |
| `amr sync` | `pull --rebase --autostash` then `push` if remote exists; no-op otherwise. |
| `amr doctor` | Repo validity, clean tree, remote, `amr` on PATH, per-host wiring report. |
| `amr install [--host ...]` | Writes adapters. Backs up each touched file (`*.amr-backup`), merges JSON, idempotent marker blocks. Default: hosts detected on machine; `all` = every known host. |

## Per-host adapter matrix

| Host | Retrieval | Save | Sync |
|---|---|---|---|
| Cursor | `sessionStart` → `amr context` (merged into `~/.cursor/hooks.json`) | `~/.cursor/rules/agent-memory-repo.mdc` (`alwaysApply: true`) | `sessionEnd` → `amr sync` |
| Claude Code | `SessionStart` hook in `~/.claude/settings.json` | `~/.claude/CLAUDE.md` marked block | `SessionEnd` → `amr sync` |
| Windsurf | `~/.codeium/windsurf/hooks.json` `sessionStart` (verify event names) | `~/.codeium/windsurf/memories/global_rules.md` block | `sessionEnd` equiv |
| Devin CLI | settings hooks key unverified → `~/AppData/Roaming/devin/AGENTS.md` block instructs `amr context` at session start | same block | same block |
| Copilot CLI | `~/.copilot/AGENTS.md` block | same block | — |
| Codex CLI | `~/.codex/AGENTS.md` block (no injectable hook; `notify` is fire-and-forget) | same block | — |
| Cline | `~/Documents/Cline/Rules/agent-memory-repo.md` + `~/.cline/AGENTS.md` block (global hooks unverified) | same blocks | — |
| Muse (muse-code) | `~/AppData/Local/hermes/SOUL.md` block | same block | — |

Hook commands use absolute `node "<cli>/amr.mjs"` paths — immune to PATH issues.
Rule block references `amr` and notes the absolute fallback. Shared canonical block
in `adapters/shared/rule-block.md`, stamped between
`<!-- agent-memory-repo -->` markers.

## Multi-repo model

One user repo, project-scoped files (the spec's folder model, not N repos):

- Slug = `<basename of git toplevel>-<6-char sha1 of origin URL>` →
  `projects/trackdub-a1b2c3.md`. Falls back to toplevel path hash when no remote.
- `amr context` injects **global + current project only** — `MEMORY.md` stays small.
- `amr add --project` routes to the project file; default writes global.
- Non-git dirs → global file.
- Composability (spec's multiplayer case): `amr.json` `extraRepos[]` → context
  concatenates those repos' `MEMORY.md`s (later phase).

## Safety, sync, dreaming

- Secrets: denylist regexes (`sk-`, `ghp_`, `github_pat_`, `AKIA`, private-key
  blocks, `xox[baprs]-`, `AIza`, JWT shapes); `--allow-secret` override.
- Concurrency: `.git/amr.lock` + pull-rebase before push.
- Remote: only a private repo the user owns; confirm before first push.
- Dreaming (later): `amr dream` run as a scheduled Devin session — dedupe, merge,
  resolve contradictions via `source` links, compact `MEMORY.md` weekly.

## Build order

1. `amr` core: `ensure`, `context`, `add` ← this implementation
2. Cursor + Devin adapters → real save/retrieve round-trip
3. Remaining commands (`update`, `search`, `index`, `remote`, `sync`, `doctor`)
4. Claude/Windsurf/Copilot adapters
5. Remote sync + `extraRepos`
6. Dreaming

## Open items

- [ ] Devin CLI hooks config key (docs/schema) — AGENTS.md is the shipped fallback
- [ ] Windsurf hooks.json event names
- [ ] Whether each host's hooks receive project cwd as arg or env
- [ ] Consider `amr` → PATH bootstrap strategy (npm link vs shims vs abs paths)

## Risks

- Save adherence is probabilistic — mitigated by rule block + in-context affordance
  + stop-hook safety net; never fully deterministic without transcript scanning.
- Other tenants own Cursor hooks.json — merge only, always back up.
- Concurrent agents — lockfile + pull-rebase; conflicts surface to the next writer.
