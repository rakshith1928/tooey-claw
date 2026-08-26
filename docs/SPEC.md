# SPEC: Claw — self-hosted autonomous agent on OpenCode 2

> Status: **ready-for-agent** (local label until a tracker is configured — migrate via `/setup-matt-pocock-skills`)
> Scope of this spec: milestones **M0–M2** as approved. M3/M4 items are listed under Out of Scope.
> Build root: `C:\Users\DELL\claw` — fully project-local; never touches the user's global OpenCode config.

## Problem Statement

I run OpenCode interactively: every useful action starts with me typing something into a session. When I close my laptop, the work stops. Recurring code-aware work — checking repos I maintain, triaging issues and CI failures, drafting responses — requires me to remember to look, every time. Meanwhile the knowledge the assistant gains in one session (what it found, what it decided, why) evaporates by the next one.

I want a personal autonomous agent that lives on my own machine, uses models and keys **I** bring, keeps working when I'm away, remembers what it learned yesterday, and stays inside its own folder instead of reconfiguring my existing OpenCode setup.

## Solution

Claw: a self-hosted autonomous layer on top of OpenCode 2, consisting of:

1. **Two built-in agents** defined declaratively in the Claw project: `claw` (orchestrator — plans, decomposes, delegates, reports) and `worker` (hands-on — reads real code, runs checks, drafts output). More specialized agents can be added later as plain files.
2. A **thin in-server plugin** (`claw-core`) that gives those agents Claw-specific tools (task management, persistent memory, delegation) and injects relevant memories into their context automatically.
3. A small **daemon** (separate process) that owns time: it schedules recurring jobs (day-one workload: *dev-work watchdog* over configured repositories), dispatches due work into OpenCode sessions, watches the event stream to know when work finished, and persists all state in SQLite so restarts are lossless.

The day-one job this is optimized for: *"watch my repos, triage what happened since last run, act or summarize"* — scheduled, unattended, code-aware.

Everything runs locally. Users bring their own models, API keys, and infrastructure; nothing is hosted for them.

## User Stories

### Boot & isolation
1. As a user, I want Claw to live entirely inside its own project folder, so that my global OpenCode configuration and other projects are untouched.
2. As a user, I want the daemon to discover or start OpenCode's background service automatically, so that booting Claw needs no manual server management.
3. As a user, I want a health check at startup that fails loudly if OpenCode isn't reachable, so that misconfiguration surfaces immediately instead of silently doing nothing.
4. As a user, I want my provider/model/API-key setup to come from standard OpenCode project configuration plus environment variables, so that I keep using the BYO-models workflow I already have.

### Scheduling & the watchdog loop
5. As a user, I want to declare which repositories to watch and how often, in a simple project-local config file, so that adjusting the watchdog requires editing data, not code.
6. As a user, I want the daemon to dispatch due jobs automatically at the configured cadence, so that work happens while I'm away.
7. As a user, I want each dispatched job to become a durable task row before execution starts, so that a crash mid-run leaves evidence rather than a silent gap.
8. As the orchestrator agent (`claw`), I want a delegation tool that spawns a worker session, hands it a bounded sub-task, and waits for its result, so that planning and hands-on work stay separated.
9. As a user, I want delegation depth capped and each delegation timeout-bounded, so that a runaway agent chain can't spin forever or recurse without limit.
10. As a user, I want the orchestrator session to be single-flight (no overlapping runs of the same loop), so that two ticks can't interleave destructively.
11. As a user, I want task completion detected from OpenCode's event stream rather than guessed timers, so that task state reflects reality.
12. As a user, I want a failed or timed-out run to be marked as such with its error recorded, so that I can see *why* nothing happened.
13. As a user, I want a kill-switch file that halts all dispatch within one scheduler tick, so that I can stop the agent instantly without killing processes.

### Persistence & recovery
14. As a user, I want tasks, schedules, and memory stored in a local SQLite database, so that state survives daemon restarts with zero external dependencies.
15. As a user, I want the daemon to recover cleanly after being killed mid-run — no orphaned running tasks, no duplicate dispatches — so that crashes are boring.
16. As a user, I want completed runs to leave a compact result record (verdict, artifacts touched, next-run pointer), so that the next cycle builds on the last one.

### Memory
17. As the orchestrator, I want a memory-save tool, so that verdicts and lessons from this run are available to future runs.
18. As the orchestrator, I want keyword-searchable retrieval over saved memories, so that I can pull up what's relevant without scanning everything.
19. As a user, I want retrieved memories injected into agent context automatically before each dispatch, so that agents benefit from memory without prompting for it.
20. As a user, I want memory recall to survive a full machine restart, so that "it remembered yesterday's triage" is literally true.

### Extensibility & safety posture
21. As a future contributor, I want new specialized agents to require only a new declarative agent file, so that adding a researcher/reviewer doesn't touch daemon code.
22. As a security-conscious user, I want permission enforcement centralized in the plugin (deny-by-default for dangerous actions unless configured), so that autonomy level doesn't depend on each model invocation behaving well.
23. As a user, I want structured logs of every dispatch, completion, and failure, so that diagnosing an unattended failure doesn't require reproducing it.

## Implementation Decisions

1. **Hybrid architecture.** In-session capabilities (tools, context injection, permission hooking) live in a plugin loaded by OpenCode's server; between-session capabilities (clock, scheduler, event listening, messaging later, storage ownership) live in the daemon. Rationale: plugins share the server lifecycle (wrong home for long-poll listeners/cron); the HTTP API alone lacks in-process tool registration.
2. **Runtime: Bun + TypeScript**, `bun:sqlite` for storage, `bun test` as the runner. The generated OpenCode client (`@opencode-ai/client@beta`) is version-pinned and called only through one thin wrapper module — the beta-churn firewall. All other modules depend on the wrapper's narrow interface, not the SDK's types.
3. **Strict project-local isolation.** Agents, plugin, project config, database, and logs all resolve relative to the Claw folder. Global user config is never read or modified by install or runtime. The shared OpenCode background service may be started/discovered by the client library (runtime state, not configuration); Claw's definitions activate only for sessions rooted in the Claw directory.
4. **Agents are declarative markdown files** (orchestrator + worker) loaded by OpenCode from project agent directories; exact frontmatter fields will be verified against the V2 configuration docs at implementation time, not guessed. Adding specialists later means adding files.
5. **Plugin tool inventory (M0–M2):** `memory_save(text, tags?)`, `memory_search(query, limit?)`, `task_create`, `task_list`, `task_update`, `delegate(agentID, prompt)` — delegate creates a session, switches it to the target agent, prompts, and waits, honoring the depth cap (max 1 in this scope) and per-delegation timeout.
6. **Context injection:** the plugin hooks session-context assembly to prepend (a) top-k memories retrieved from the current task's keywords and (b) the open task list. Injection content assembly is a pure function so it can be snapshot-tested without OpenCode.
7. **Permission hook:** plugin registers a permission-evaluation hook implementing a deny-by-default policy for destructive actions, with an explicit configured allowance list. Configured explicit denies remain final (OpenCode semantics).
8. **Storage schema (SQLite, WAL mode):** `tasks(id, type, payload_json, status[queued|running|done|failed], error, result_json, created_at, started_at, finished_at)`, `schedules(id, name, cadence, target, enabled, last_dispatched_at)`, `memory(id, text, tags, created_at)` + an FTS5 index over memory text/tags. Vector search is deferred; memory access goes through one repository interface so an embedding-backed implementation can replace FTS later.
9. **Scheduler:** fixed-interval tick loop driven by an injectable clock (never raw `Date.now()` in loop logic); due schedules dispatch exactly once, guarded by a single-flight lock per loop and persisted `last_dispatched_at`.
10. **Completion detection:** the daemon subscribes to the server event stream and transitions task rows to done/failed from session lifecycle events; a watchdog timer force-fails tasks whose session died without a terminal event.
11. **Watchdog workload shape:** schedule entries reference watched repos; each tick produces a "check repo X since last successful run" task whose payload carries the previous run's result pointer, enabling incremental ("since last time") behavior.
12. **Kill-switch:** existence of a sentinel file in the data directory disables all dispatch; checked every tick before anything runs.
13. **Secrets:** environment variables only (`.env`, gitignored); never written to config files or the database.

## Testing Decisions

Good tests here assert **external behavior**: what gets dispatched, what lands in the database, what a prompt ends up containing — not internal call graphs.

Approved seams (exactly two integration seams + pure functions; no network, no model calls, no live OpenCode process):

1. **Daemon-loop seam.** The daemon depends on two interfaces: a clock and an OpenCode client port. Tests drive the entire loop with a fake clock and a recording fake client (canned events), then assert on dispatches and on a real temporary-file SQLite database. This seam covers scheduling → dispatch → event-driven completion → persistence, including the kill-mid-run/restart recovery story (close mid-run, reopen DB, resume, assert no duplicates/orphans).
2. **Memory seam.** Save/search round-trips directly against a temp SQLite file exercising real FTS5; injection-content assembly is a pure function covered by snapshot tests.

Prior art: none in-repo (greenfield); tests are written first alongside each module (TDD), using `bun test`.

## Out of Scope

Deferred by design, not forgotten:

- **M3 — Messaging:** Telegram adapter (chosen as first channel), generic webhook receiver, `claw status/tell` CLI.
- **M4 — Hardening:** daily token/cost budget system, graduated autonomy levels (supervised/semi/full) as user-facing modes, packaged installation/service registration (NSSM/scheduled task), metrics.
- Vector/embedding-based semantic memory (FTS5 ships; the repo interface anticipates swap-in).
- Multi-machine orchestration, remote/hosted deployments, agent marketplaces.
- Specialist agents beyond `claw` and `worker` (mechanism supported; none built).
- Any modification of the user's global OpenCode configuration.

## Further Notes

- The V2 API/plugin surface is **beta**: expect contract drift. Mitigations are structural (pinned dep, single wrapper module, seams), and upgrades should be a one-module review.
- All OpenCode behavior questions defer to the V2 documentation as source of truth; V1 docs are not consulted.
- Windows-first: the daemon runs as a plain foreground process in this scope; service-install ergonomics arrive with M4.
- Day-one workload validated with the user: **dev-work watchdog** (repo issues/PRs/CI triage). Personal-ops and local-butler workloads should fall out naturally from the same loop.
- Spec published locally pending tracker setup; migrate to the project tracker (with `ready-for-agent` triage) once `/setup-matt-pocock-skills` has been run.
