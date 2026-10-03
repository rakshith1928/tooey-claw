# 08: Memory tools & auto-injection

**What to build:** Agents get `memory_save` and `memory_search` tools from the plugin, and the injection assembly (pure function) automatically prepends top-k relevant memories (keyed off the current task's keywords) plus the open task list to dispatched prompts. Proof of the memory promise: a verdict saved during run N is recalled by run N+1 after a full daemon restart.

**Blocked by:** 04 (Delegation path), 07 (Memory store FTS5).

**Status:** done

- [x] Both memory tools execute correctly from an agent session (round-trip via fake client)
- [x] Injection-content assembly is snapshot-tested: memories block + open-tasks block shape stable
- [x] Dispatched prompt demonstrably contains the injected block (fake-client assertion)
- [x] End-to-end: verdict written in run N is present in run N+1's prompt after daemon restart
