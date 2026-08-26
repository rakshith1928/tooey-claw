# 01: Boot & wiring

**What to build:** Running the dev command boots the Claw daemon, which discovers or starts OpenCode's background service, passes a health check, and proves the whole chain is alive: the two project-local built-in agents (`claw` orchestrator, `worker`) are listed through the API, and the `claw-core` plugin loads with a probe tool invocable from a session rooted at the Claw folder. Strict isolation holds — sessions in any other directory see none of this, and nothing is ever written outside the Claw folder. Exact agent-definition frontmatter is verified against the current V2 configuration documentation during this ticket (not guessed).

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Dev command starts the daemon and reports health OK against a reachable OpenCode service
- [x] Listing agents through the API shows both `claw` and `worker` with their intended roles
      (`claw`: mode=primary, steps=12; `worker`: mode=all — system prompts loaded from markdown bodies)
- [x] The plugin appears loaded and its probe tool executes successfully in a Claw-rooted session
      (live probe: session created → orchestrator agent → pinned free model → `claw_probe` executed →
      transcript contained `claw-core OK (OpenCode 0.0.0-beta-18286)`; probe output also proves the
      port/adapter/SDK chain end-to-end)
- [x] Isolation proven: a session rooted elsewhere does not see Claw agents or plugin
      (agents query at parent directory returned no claw/worker)
- [x] Agent frontmatter fields verified against V2 docs; deviations noted in the PR/ticket comments
      (V2 agents guide fetched and followed: `.opencode/agents/<name>.md`, fields description/mode/steps/
      color/permissions, body becomes system. Notes: (1) An interim "markdown not picked up" diagnosis was
      WRONG — the shared service had snapshotted the folder before files existed and ignored all new content,
      including explicit config entries. Fresh-location tests proved markdown agents load correctly on clean
      discovery; the interim fat-config workaround was removed. Final repo uses markdown files + minimal config.
      (2) Plugin auto-discovery from `.opencode/plugins/` confirmed working without a config entry.
      (3) Beta API deviation found: session.create expects `model:{providerID,id}` not `modelID`;
      mapped inside the adapter (firewall), port unchanged.)
- [x] Git initialized; `.gitignore` excludes database files, env files, and dependencies; clean initial commit

**Environment notes for future tickets:**

- The shared background service freezes a location's file-set at first load;
  eviction does not re-scan. Verification used pristine locations
  (`D:\Temp\opencode\claw-fresh*`). One `opencode2 service restart` fixes the
  canonical folder permanently (deferred: this dev session rides the same service).
- Probe cost control: set `CLAW_PROBE_MODEL` (e.g. a free endpoint) so probes stay cheap.
