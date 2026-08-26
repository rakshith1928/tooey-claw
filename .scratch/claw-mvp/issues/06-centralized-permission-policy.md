# 06: Centralized permission policy

**What to build:** The plugin registers the permission-evaluation hook enforcing a deny-by-default policy for destructive actions, with an explicitly configured allowance list — enforced centrally regardless of what any model invocation attempts. Explicit configured denies remain final (OpenCode semantics). Policy configuration lives in the project-local config file. Verified at the hook seam with fabricated evaluation events.

**Blocked by:** 01 (Boot & wiring).

**Status:** ready-for-agent

- [ ] Destructive action attempt is denied centrally via the hook (hook-level test)
- [ ] Allowlisted actions pass through unchanged
- [ ] An explicit configured deny is final and never overridden by the hook
- [ ] Policy rules load from project-local configuration
