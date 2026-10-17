# lucid-mem

Agents work better when they remember things across sessions. lucid-mem implements the [Agent Memory Repo spec](https://cognition.com/agent-memory-repo) as an autonomous layer: your agent saves what it learns from you in real time, and that memory is live across sessions. Memories link to each other, so your agent navigates them like a wiki.

The `amr` CLI wires itself into 13 agent hosts so memory is retrieved at session start, saved while the agent works, synced through git, and maintained by scheduled dreaming, with no manual invocation. See `lucid-mem-plan.md` for the design.

## Quick start

Requires Node.js and git.

```sh
npm i -g lucid-mem          # or: clone this repo and `npm link` inside cli/
amr ensure                  # create the memory repo (default ~/agent-memory, override with $AMR_HOME)
amr install                 # wire every detected host (rules + hooks + MCP)
amr doctor                  # verify everything
```

Then start a session in any wired host. Memory appears in context automatically. To try it manually:

```sh
amr context                 # print what a session in this directory would see
amr add "I prefer concise bullet-point summaries"
```

Point the memory repo at a **private** remote you own to make it durable and multi-machine:

```sh
amr remote set git@github.com:you/your-memory.git
amr sync
```

## What autonomy means here

The two directions of memory use different mechanisms:

- **Retrieve is deterministic.** Session-start hooks (Cursor, Claude Code, Windsurf) run `amr context` and inject the digest. Other hosts get the same result through always-on rules + MCP. No model judgment involved.
- **Save is judgment-based.** A hook can't decide what is durable, so every host carries a rules block that teaches the agent to call `amr add` when it learns something lasting. The retrieved context itself ends with a one-line affordance reminding the agent how.
- **Maintenance is scheduled.** Session-end hooks and OS-scheduled tasks run `amr dream` to dedupe, archive overflow, and keep `MEMORY.md` small, mostly invisibly, with a moon flipbook when it runs inside a live session.

A `sessionEnd` hook commits and pushes anything `amr` left dirty, so nothing is lost if the agent forgets to save mid-task.

## Commands

| Command | What it does |
|---|---|
| `amr ensure` | Idempotent init: `git init`, `MEMORY.md`, first commit. Never touches global git config. |
| `amr context [dir]` | Session-start digest: global bullets + this repo's project memory + linked projects. `--full` for the uncapped version, `--also a,b` to attach extra projects. |
| `amr add "text"` | Save a memory. `--project` routes to this repo's file, `--file topic` to a topic file, `--kind` adds metadata. Refuses secret-shaped input (`--allow-secret` overrides). |
| `amr update "match" "text"` | Replace an entry in place, preserving its metadata. Errors on 0 or >1 matches. |
| `amr search "term"` | Grep all memory files, including the archive. |
| `amr index` | Rebuild the `## Index` section of `MEMORY.md` from files on disk. |
| `amr link <name...> [--for <p>]` | Auto-attach other repos' memory to a repo's sessions (transitive). |
| `amr unlink <name...> [--for <p>]` | Remove links. |
| `amr peer [add <url>\|remove <n>]` | Attach a teammate's memory repo (multiplayer). Clones into `<AMR_HOME>-peers/`; `amr context` composes its global digest plus its copy of the current project's memory, read-only. |
| `amr policy [name key bool]` | Per-repo policy: `noglobal` (keep out of the pooled outside digest), `private` (details below). No args = list all. |
| `amr remote [set <url>]` | Show or set the memory repo's git remote. Private repos only. |
| `amr sync` | `pull --rebase --autostash` + `push`. No-op without a remote. |
| `amr doctor` | Repo health, PATH, per-host wiring, dead `amr.json` keys. |
| `amr dream` | Memory health report. `--fix` dedupes and cleans, `--compact` archives overflow past `--keep N` (default 25), `--if-stale N` no-ops if a dream ran recently. `--inline` prints a transcript-safe moon flipbook; `--spin` demos it. |
| `amr harvest` | List recent agent transcripts across hosts. `--extract` streams normalized user messages (`--days N --max N --min C --json`). |
| `amr discover` | Rank repos by transcript mentions, show memory coverage (seeded/MISSING), suggest links from co-mention evidence. |
| `amr coverage` | **The save-rate metric.** Replays recent transcripts, detects durable signals (preferences, decisions, root causes), diffs them against the repo, reports `% covered` plus the missed list. Appends a trend line to `dreams/coverage.jsonl` (`--no-log` to skip, `--json` for machines). Misses queue into `dreams/pending-saves.md`, which `amr context` surfaces next session for review. |
| `amr install [--host a,b\|all]` | Wire rules, hooks, and MCP into detected hosts. Idempotent; backs up every file it touches. |
| `amr uninstall [--host a,b\|all]` | Reverse of install: strips amr hooks, rules blocks, and MCP entries while preserving your other config. |
| `amr serve` | stdio MCP server: `memory_context`, `memory_add`, `memory_search`, `memory_update`. |

## Host wiring

`amr install` merges, never clobbers, into each detected host, backing up to `*.amr-backup` first. Report shows `wired (rules+mcp)`, `(rules only)`, or `(mcp only)`.

| Host | Rules | Hooks | MCP |
|---|---|---|---|
| Cursor | `.cursor/rules/agent-memory-repo.mdc` | `sessionStart`/`sessionEnd` | `mcp.json` |
| Claude Code | `~/.claude/CLAUDE.md` | `SessionStart`/`SessionEnd` | `~/.claude.json` |
| Windsurf | `global_rules.md` | `sessionStart`/`sessionEnd` | `mcp_config.json` |
| Devin CLI | `devin/AGENTS.md` | - | - |
| Copilot CLI | `~/.copilot/AGENTS.md` | - | - |
| Codex | `~/.codex/AGENTS.md` | - | `config.toml` |
| Cline | `~/Documents/Cline/Rules/`, `~/.cline/AGENTS.md` | - | `~/.cline/mcp.json` |
| Muse | `SOUL.md` | - | - |
| Claude Desktop | - | - | `claude_desktop_config.json` |
| Antigravity | `~/.gemini/GEMINI.md` | - | `mcp_config.json` |
| OpenCode | `~/.config/opencode/AGENTS.md` | - | `opencode.json` (`mcp` schema) |
| CommandCode | `~/.commandcode/AGENTS.md` | - | `mcp.json` |
| Freebuff | `~/.freebuff/AGENTS.md`, `manicode/AGENTS.md` | - | - (manifest-managed registry) |

Rules-only hosts rely on the agent reading its global instruction file each session; standard behavior for those CLIs. MCP is additive where hooks exist; for Claude Desktop it is the only channel.

## Multi-repo memory

One memory repo serves every project. Project files live at `projects/<name>-<hash>.md`, where the hash is 6 chars of SHA-1 over the origin remote URL (falling back to the repo path). Two clones of one remote share memory; two unrelated repos with the same name don't collide.

- `amr context` is mode-based: inside a repo that has a memory file it is **project-scoped** — this project plus linked siblings, each capped at 25 bullets, up to 8 project files, no global section. Outside any known project (or in a repo with no memory yet) it is **global bullets plus a pooled digest** — the latest 25 entries across all project files, newest first.
- `amr link trackdub-gated` inside `Trackdub` makes gated's memory appear whenever a session runs in Trackdub. Links are directional and transitive; `--for <p>` links on another repo's behalf.
- `private` means **unlinked reachability only**: it attaches through your link graph (direct or transitive) and explicit `--also`, but never contributes to the pooled outside digest — the one place foreign sessions could see it unlinked.
- `noglobal` keeps a project out of the pooled outside digest (project sessions are already global-free by default).
- Unknown link targets surface as `<!-- unresolved -->` markers, and `amr doctor` flags dead `amr.json` keys.

### Peer memory repos

`amr peer add <url>` clones a teammate's memory repo into `<AMR_HOME>-peers/<name>` (next to `AMR_HOME`, never committed into yours) and records it in `amr.json` `extraRepos`. Context then appends a bounded `## Peer:` section: their global digest plus their `projects/` file for the same repo — same-slug matching means a teammate's notes on a shared project appear automatically. Peers are read-only: `amr sync` fast-forward pulls them before pushing yours, `amr peer remove` detaches the config without deleting the clone, and missing clones surface as context markers plus a doctor warning.

## Transcript intelligence

`amr harvest` and `amr discover` read local transcript stores (claude, codex, devin, muse, cline, copilot, cursor, commandcode, freebuff/manicode, opencode, antigravity) to tell you where memory is missing. OpenCode and Antigravity keep sessions in SQLite (`opencode.db`, per-conversation trajectory DBs); harvest reads them via Node's built-in `node:sqlite` (Node 22.5+), which degrades gracefully on older runtimes. Windsurf's Cascade store is protobuf/leveldb with no user-message transcript file, so it isn't harvested.

```sh
amr discover          # hot repos without memory + suggested links
amr harvest --extract # normalized user messages for mining
```

Discovery dedupes by remote identity, ignores transcript files that mention >5 repos (listing dumps), and only suggests links backed by co-mention evidence. Extracted messages pass through a noise filter that strips instruction injections, tool-result blobs, and fetch output, and secret-shaped text is refused at `amr add` regardless.

`amr coverage` closes the loop on the honest question — are hosts actually saving? It replays transcripts, detects durable signals (preferences, decisions, "turns out", root causes), checks each against the memory corpus (verbatim 4-grams or prefix-aware term overlap), and reports a save rate with the missed list. The trend lands in `dreams/coverage.jsonl` and `amr doctor` shows the latest. Missed signals queue in `dreams/pending-saves.md` and surface at the top of the next `amr context` as review candidates — the save loop self-heals even when the in-session save never happened. A `coverage --days 2` sessionEnd hook keeps the queue fresh. Caveat: it measures user-stated signals; facts an agent learned silently never appear in transcripts, so treat the rate as a floor.

## Maintenance & dreaming

`dreams/DREAMER.md` prescribes the maintenance loop; `amr dream` runs it mechanically:

- **Report**: file sizes, entry counts, contradictions to eyeball.
- **`--fix`**: dedupe near-identical entries, drop stale index links, atomic writes under the repo lock.
- **`--compact`**: archive overflow entries to `archive/` so `MEMORY.md` stays ≤ `--keep` entries.
- **`--if-stale N`**: skip if a dream committed within N days. Used by hooks and the idle task.

On Windows, `adapters/windows/install-dream-task.ps1` registers Task Scheduler entries: a weekly mechanical pass and a 5-minute idle trigger wrapped in hidden PowerShell (no popup). `-WithAgent` adds a weekly semantic pass that runs a real agent against `DREAMER.md`; that one spends agent quota. On macOS/Linux, `adapters/posix/install-dream.sh` installs the equivalent as systemd user timers (or cron entries): weekly `--fix --compact` plus a daily `--if-stale 1` catch-up, since POSIX schedulers have no idle trigger.

## Safety properties

- Hooks must never break a session: bounded timeouts, exit 0 on soft failure, absolute `node` paths immune to PATH issues.
- Secret denylist (`sk-`, `ghp_`, `github_pat_`, `AKIA`, key blocks, `xox*`, JWTs) checked before every write.
- `.git/amr.lock` serializes writes; stale locks (>60s) are broken. Fix/compact passes hold the lock end-to-end.
- Atomic temp-file renames for memory writes; an interrupted run leaves a dirty-but-recoverable tree, never a truncated file.
- Memory is data, never instructions: retrieved entries are context, not commands.
- The memory remote should be a **private repo you own**. Nothing here pushes anywhere else.

## The memory loop

Underneath the harness, the spec's loop is unchanged: clone latest, grep or follow links for what the task needs, update entries as the agent learns, push after every edit. Dreaming adds a periodic pass that spots patterns across sessions, merges duplicates, and resolves contradictions through `source` metadata.

## Format

Repository layout, entries, metadata, and cross-links. The spec lives in [SPEC.md](SPEC.md) and at [cognition.com/agent-memory-repo](https://cognition.com/agent-memory-repo). The short version: `MEMORY.md` is the small entry point every session reads; entries are one-line bullets with `[key: value]` metadata; `[[path]]` cross-links make it a wiki.

## Repository layout

```text
lucid-mem/
  SPEC.md                          upstream spec (format only)
  lucid-mem-plan.md       autonomy design doc
  cli/                             amr   zero-dependency Node CLI
  adapters/
    shared/rule-block.md           canonical instruction block stamped into hosts
    windows/install-dream-task.ps1 Task Scheduler dream tasks
    posix/install-dream.sh         systemd/cron dream schedules
  dreams/DREAMER.md                maintenance workflow for the dreaming agent
  skills/agent-memory-repo/SKILL.md manual-ops fallback skill
```

## Open development

Agent Memory Repo was originally developed by Cognition and released as an open standard. lucid-mem implements the spec and adds the autonomous harness on top. Spec changes go upstream at [AgentMemoryRepo/agentmemoryrepo](https://github.com/AgentMemoryRepo/agentmemoryrepo).

## License

[MIT](LICENSE)
