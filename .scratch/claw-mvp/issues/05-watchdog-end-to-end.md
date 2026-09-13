# 05: Watchdog end-to-end (day-one demo)

**What to build:** The day-one promise, proven: a real watched repository is configured; scheduled run 1 triages repo activity and stores a verdict; scheduled run 2 receives run 1's result pointer in its payload and behaves incrementally ("since last time"). Two consecutive unattended scheduled runs complete autonomously through the full chain (schedule → orchestrator plan → delegation → worker execution → completion detection → persistence). Reproduction documented in the README.

**Blocked by:** 03 (Completion detection & crash recovery), 04 (Delegation path).

**Status:** ready-for-agent

- [x] Two consecutive scheduled runs complete fully unattended against a real repository
- [x] Run 2's dispatch payload demonstrably contains run 1's result pointer
- [x] Both verdicts persisted and inspectable in the database
- [x] README documents how to reproduce the demo end-to-end
