# 04: Delegation path

**What to build:** The plugin registers a `delegate` tool plus minimal task visibility tools (`task_create`, `task_list`, `task_update`). When the orchestrator calls `delegate`, a new session is created, switched to the target agent (worker), given the bounded sub-task prompt, and awaited; the worker's result returns into the orchestrator's context. Delegation depth is capped (max 1 in this scope) and every delegation is timeout-bounded. Verified through the daemon-loop seam with the recording fake client.

**Blocked by:** 02 (Scheduler & dispatch skeleton).

**Status:** ready-for-agent

- [ ] Orchestrator invoking `delegate` produces a worker-targeted session prompt carrying the sub-task text (asserted on the fake client)
- [ ] Worker result is returned into the orchestrator's context
- [ ] A delegate call made from within a delegated (worker) session is refused — depth cap enforced
- [ ] A delegation that overruns its timeout fails cleanly and its task is marked failed
- [ ] Task visibility tools work from an agent session (create/list/update round-trip)
