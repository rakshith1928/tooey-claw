# 03: Completion detection & crash recovery

**What to build:** The daemon subscribes to OpenCode's event stream and transitions task rows to done or failed based on real session lifecycle events — recording compact results (verdict/artifacts/next-run pointer) or errors accordingly. A watchdog timer force-fails tasks whose session died without a terminal event. Being killed mid-run and restarted leaves no orphaned running tasks and no duplicate dispatches; the loop simply continues. All proven through the daemon-loop seam, including the kill-mid-run/restart scenario.

**Blocked by:** 02 (Scheduler & dispatch skeleton).

**Status:** ready-for-agent

- [ ] Terminal success event → task done with result JSON recorded
- [ ] Failure event → task failed with error stored
- [ ] Session death without terminal event → force-failed by watchdog timer (fake clock)
- [ ] Kill mid-run → reopen database → restart: orphan swept, no duplicate dispatch, loop continues
- [ ] Completed runs persist the compact result record including the pointer consumed by the next incremental run
