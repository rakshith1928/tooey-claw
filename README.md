# Claw

Self-hosted autonomous agent built on OpenCode V2. Runs locally, uses your own
models/keys/infrastructure. Day-one workload: a dev-work watchdog that watches
your repositories on a schedule, triages what changed since the last run, and
records verdicts it can build on.

See `docs/SPEC.md` for the full spec and `.scratch/claw-mvp/issues/` for tickets.

## Architecture (one paragraph)

Two declarative agents (`claw` orchestrator plans-and-delegates; `worker`
executes bounded hands-on sub-tasks) plus a thin plugin (`claw-core`) that runs
inside OpenCode sessions providing Claw tools, and a small daemon (Bun +
TypeScript) that owns time: schedules, dispatch, event-driven completion, and
SQLite persistence. Strictly project-local: nothing outside this folder is
read or modified.

## Layout

```
opencode.json            # project config (default_agent)
claw.example.json        # scheduler config template → copy to claw.json (gitignored)
.opencode/
  agents/claw.md         # orchestrator agent definition
  agents/worker.md       # worker agent definition
  plugins/claw-core.ts   # in-session tools (probe today; task/memory/delegate next)
daemon/src/
  ports.ts               # THE seam: ClawOpenCodePort + Clock interfaces
  opencode.ts            # only file allowed to know @opencode-ai/* (beta firewall)
  paths.ts               # project-local path resolution
  config.ts              # claw.json parsing (schedules, cadences, dispatch model)
  db.ts                  # SQLite (bun:sqlite, WAL): tasks + schedules
  clock.ts               # SystemClock — the only real-wall-time implementation
  scheduler.ts           # tick loop: kill switch, due check, claim, dispatch
  checks.ts              # pure boot-acceptance predicates
  index.ts               # entry: boot checks → probe mode or scheduler run mode
daemon/test/             # unit tests (fake clock / recording fake port / temp SQLite)
docs/SPEC.md             # spec
.scratch/claw-mvp/       # tickets
```

## Running

```sh
bun install
```

Free infrastructure checks (no sessions, no model calls):

```sh
bun run check
```

Live probe (real session, real model call, invokes the plugin tool):

```sh
# CLAW_PROBE_MODEL="provider/model" pins the model (recommended: use a cheap/free one)
$env:CLAW_PROBE = "1"
$env:CLAW_PROBE_MODEL = "openrouter/openrouter/free"   # example
bun run dev
```

Scheduler run mode (ticket 02): copy the config template, edit schedules/repos, run the daemon.
It boots through the same checks, then ticks: due schedules dispatch once into a `claw`
session, with a durable task row and the kill switch (`data/kill`) honored every tick.

```sh
cp claw.example.json claw.json   # gitignored — names your private repos
bun run dev                       # Ctrl-C stops; data/kill halts dispatch without stopping
bun test                          # tests at the approved seams (no network/model calls)
bun run typecheck
```

## Watchdog end-to-end demo (ticket 05)

Two consecutive unattended scheduled runs against a real repository, with run 2
behaving incrementally off run 1's verdict. Reproduce:

1. **Configure** `claw.json` with a real repo and a short cadence for the demo
   (config uses Windows paths here; adjust to taste):

   ```json
   {
     "tickSeconds": 10,
     "model": "openrouter/openrouter/free",
     "schedules": [
       {
         "id": "demo",
         "name": "Demo repo",
         "repo": "C:\\path\\to\\a\\real\\repo",
         "cadence": "every:2m",
         "prompt": "Watchdog run for this repository. Check recent git activity: run `git log --oneline -5` and `git status --short`. Reply with a compact verdict of the form: VERDICT: <one sentence on repo state> NEXT-RUN: <most useful pointer for the next incremental run, e.g. the newest commit hash you saw>. Keep it to those two lines, nothing else.",
         "enabled": true
       }
     ]
   }
   ```

2. **Fresh state, then run the daemon** (leave it running through two cadence
   windows — with `every:2m`, about 5 minutes total):

   ```sh
   rm data/claw.db*          # optional: start from a clean slate
   bun run dev
   ```

   The daemon boots through the checks, sweeps any orphans, starts the
   completion watcher, and ticks every 10s. Run 1 dispatches immediately.

3. **Watch it happen** in the daemon's own log lines:

   ```
   [claw] scheduler running: 1 schedule(s), tick 10s, db data\claw.db
   [claw] dispatched ticket-05-demo → session ses_… (task …)          ← run 1
   [claw] task … done (session ses_…)
   [claw] dispatched ticket-05-demo → session ses_… (task …) [incremental]   ← run 2
   ```

4. **Prove it in the database** — both verdicts persisted, run 2's payload
   carrying run 1's pointer:

   ```sh
   bun -e 'import {openClawDb} from "./daemon/src/db"; const db = openClawDb("data/claw.db");
     for (const t of db.listTasks({type:"watchdog"})) console.log(t.status, JSON.stringify(t.result));
     db.close()'
   ```

   Run 2's task payload also embeds `previous` (the pointer channel), and the
   run-2 prompt visibly contains a `PREVIOUS RUN` section with run 1's verdict —
   that is the incremental behavior, by construction.

The whole chain, unattended: schedule → orchestrator session → completion
detected from the server event stream → verdict + pointer persisted → next
dispatch inlines them → second completion. A due schedule whose previous run is
still in flight is held, not stacked.

## Status

- [x] Ticket 01 — boot & wiring (agents load, plugin active, live probe green)
- [x] Ticket 02 — scheduler & dispatch skeleton (fake-clock tests, live demo fired once)
- [x] Ticket 03 — completion detection & crash recovery
- [x] Ticket 04 — delegation path
- [x] Ticket 05 — watchdog end-to-end (two unattended incremental runs, live-proven)
- [ ] Ticket 06 — centralized permission policy
- [ ] Ticket 07 — memory store (FTS5)
- [ ] Ticket 08 — memory tools & auto-injection

## Known environment quirk (not a code bug)

OpenCode's shared background service snapshots a project's file-set when it
first loads a location and does not re-scan newly added `.opencode/` content,
even after `/api/debug/location` eviction. If agents/plugin appear missing:

```sh
opencode2 service restart
```

After a restart, discovery picks up everything (verified against pristine
locations). Models/providers are configured per-user in standard OpenCode
configuration; bring your own keys.
