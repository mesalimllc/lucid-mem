# lucid-mem

`amr` CLI (Node >=18, ESM, no runtime dependencies) implementing the Agent Memory Repo spec. See `README.md` for usage, `SPEC.md` and `lucid-mem-plan.md` for design.

## Layout

- `cli/` - the package (`amr.mjs` entry, `lib/` commands, `test/`). `package.json` lives here, not at the repo root.
- `adapters/` - per-OS and shared host integration assets.
- `dreams/DREAMER.md` - instructions for the scheduled maintenance pass.
- `skills/` - skill shipped to wired hosts.

## Commands

Run from `cli/`:

- `npm test` (`node --test`) runs the suite. Keep it green before committing.

## Conventions

- Entries are addressed by short hex IDs (`amr update <id>`), never substring matching.
- Transient session data (CI runs, PR numbers, SHAs) is saved as `--kind state` so it expires; it must not become durable memory.
- Only `amr used` counts as a usage signal for ranking. Search hits must not boost an entry.
- `amr context` stays within its character budget; do not add output that bypasses the ranker.
- Judge/reflect output goes to the review queue, not directly into memory.
- When spawning a child `claude -p` from a hook or judge, pass `--settings '{"disableAllHooks":true}'`, otherwise the child re-runs session hooks.
- Config merges in `amr install` must fail closed: leave an unparseable host config untouched, report that host as failed, and exit non-zero.

## Testing changes

Hooks installed on a developer's machine usually run an installed copy of `amr`, not the working tree. Reinstall or relink before judging hook behavior from a session.
