# lucid-mem

Autonomous, git-backed memory for AI coding agents. `amr` keeps what your agents learn across sessions and across repositories: it injects memory at session start, lets agents save durable facts while they work, syncs through git, and maintains itself with scheduled dreaming — no manual invocation.

Implements the [Agent Memory Repo spec](https://github.com/AgentMemoryRepo/agentmemoryrepo). Full docs and per-host details live in the [project repo](https://github.com/mesalimllc/lucid-mem).

## Install

```sh
npm i -g lucid-mem        # gives you `amr` (and `lucid` as an alias)
amr ensure                # create the memory repo (default ~/agent-memory, $AMR_HOME to override)
amr install               # wire rules + hooks + MCP into detected agent hosts
amr doctor                # verify everything
```

Then start a session in a wired host — Cursor, Claude Code, Windsurf, Devin, Copilot, Codex, Cline, Muse, Claude Desktop, Antigravity, Gemini CLI, Zed, OpenCode, CommandCode, or Freebuff — and memory is already in context.

## Daily use

Mostly you don't touch it; agents do. Useful by hand:

```sh
amr context               # what a session here would see
amr add "I prefer concise summaries"          # global memory
amr add "uses Kokoro-82M for TTS" --project   # this repo's memory
amr search "tts"
amr link other-repo       # auto-attach another repo's memory to sessions here
amr peer add <url>        # compose a teammate's memory repo into your context
amr discover              # which hot repos still lack memory
amr dream --fix --compact # dedupe + archive overflow
```

Memory lives in `~/agent-memory` — a real git repo you can read, diff, and point at a private remote (`amr remote set <url>`) for sync and backup.

## Multi-repo memory

One memory repo serves every project. `projects/<name>-<hash>.md` files key off the repo's origin remote, so clones share memory and same-named repos don't collide. Inside a known repo, `amr context` is project-scoped — the project's latest 25 plus linked siblings (up to 8 projects). Outside one, it shows global bullets plus the latest 25 pooled across all projects. `private` and `noglobal` policies keep a project out of the pooled digest (links still reach private projects — your link graph is your own curation).

## MCP

`amr serve` is a stdio MCP server (`memory_context`, `memory_add`, `memory_search`, `memory_update`) — `amr install` registers it with hosts that support MCP.

## Links

- Repo: https://github.com/mesalimllc/lucid-mem
- Spec: https://github.com/AgentMemoryRepo/agentmemoryrepo
- License: MIT
