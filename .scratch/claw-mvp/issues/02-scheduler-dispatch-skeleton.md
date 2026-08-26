# 02: Scheduler & dispatch skeleton

**What to build:** A project-local config declares watched repositories and cadences. On each scheduler tick (driven by an injectable clock, never raw wall-time in loop logic), due schedules dispatch exactly once into an orchestrator session, with a durable task row created before execution begins. A single-flight lock prevents overlapping runs of the loop, and a kill-switch sentinel file halts all dispatch within one tick. Verified primarily through the approved daemon-loop seam (fake clock + recording fake client + real temporary SQLite), plus one manual live-fire demo.

**Blocked by:** 01 (Boot & wiring).

**Status:** done (2026-08-26) — 62-test suite green (35 new: config/db/scheduler), tsc clean, live-fire demo verified: real session dispatched once, task row `running` with sessionID, `last_dispatched_at` claimed, `data/kill` halted dispatch within one tick and removal resumed.

- [x] Fake-clock test: due schedule dispatches exactly once; a subsequent tick does not duplicate
- [x] Task row transitions to running before the prompt is dispatched
- [x] A not-yet-due schedule does not fire
- [x] Single-flight lock blocks a second concurrent run of the loop (tested)
- [x] Kill-switch file present → next tick performs no dispatch (tested); removing it resumes
- [x] Manual live demo: one real schedule fires once against the local service
