# 02: Scheduler & dispatch skeleton

**What to build:** A project-local config declares watched repositories and cadences. On each scheduler tick (driven by an injectable clock, never raw wall-time in loop logic), due schedules dispatch exactly once into an orchestrator session, with a durable task row created before execution begins. A single-flight lock prevents overlapping runs of the loop, and a kill-switch sentinel file halts all dispatch within one tick. Verified primarily through the approved daemon-loop seam (fake clock + recording fake client + real temporary SQLite), plus one manual live-fire demo.

**Blocked by:** 01 (Boot & wiring).

**Status:** ready-for-agent

- [ ] Fake-clock test: due schedule dispatches exactly once; a subsequent tick does not duplicate
- [ ] Task row transitions to running before the prompt is dispatched
- [ ] A not-yet-due schedule does not fire
- [ ] Single-flight lock blocks a second concurrent run of the loop (tested)
- [ ] Kill-switch file present → next tick performs no dispatch (tested); removing it resumes
- [ ] Manual live demo: one real schedule fires once against the local service
