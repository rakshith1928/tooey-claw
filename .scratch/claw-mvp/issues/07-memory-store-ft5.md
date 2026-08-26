# 07: Memory store (FTS5)

**What to build:** A persistent memory repository backed by SQLite FTS5 (keyword search over text and tags), exposed behind a single narrow interface so a future embedding/vector implementation can replace it without touching callers. Round-trips are verified directly against a real temporary database file, including across a simulated process restart (close and reopen). No OpenCode involvement in these tests.

**Blocked by:** 02 (Scheduler & dispatch skeleton).

**Status:** ready-for-agent

- [ ] Save then keyword search returns the saved entry with sensible ranking
- [ ] Tag-filtered search works
- [ ] Entries survive close/reopen of the database (restart semantics)
- [ ] The public interface leaks no storage-engine specifics (FTS details stay internal)
- [ ] WAL mode enabled; schema migrations applied idempotently on open
