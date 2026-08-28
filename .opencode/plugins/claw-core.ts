/**
 * claw-core — the in-server Claw plugin.
 *
 * Owns everything that must live INSIDE OpenCode sessions (per spec decision 1):
 * - delegate + task visibility tools (ticket 04), backed by the SAME daemon
 *   modules the daemon tests cover (delegate.ts / taskops.ts over the shared
 *   data/claw.db — WAL handles the daemon + server two-process access);
 * - context injection + permission hooks (tickets 06/08).
 *
 * Loaded automatically because it sits under .opencode/plugins/.
 */
import { Plugin } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import path from "node:path"
import { sessionControl, type SessionApiLike } from "../../daemon/src/opencode"
import { runDelegation } from "../../daemon/src/delegate"
import { taskCreate, taskList, taskUpdate, taskSummary } from "../../daemon/src/taskops"
import { openClawDb } from "../../daemon/src/db"
import { canonical } from "../../daemon/src/paths"
import { loadConfig } from "../../daemon/src/config"
import { SystemClock } from "../../daemon/src/clock"

// The Claw root is two directories above .opencode/plugins/ — deterministic,
// independent of the server process cwd.
const CLAW_ROOT = canonical(path.join(import.meta.dir, "..", ".."))

export default Plugin.define({
  id: "claw-core",
  async setup(ctx) {
    console.log(`[claw-core] loaded (OpenCode ${ctx.app.version}, root ${CLAW_ROOT})`)

    const db = openClawDb(path.join(CLAW_ROOT, "data", "claw.db"))
    // Config is best-effort here: delegate tools work without claw.json
    // (server-default model); the daemon hard-requires it for scheduling.
    let delegateTimeoutMs = 600_000
    let model: { providerID: string; modelID: string } | undefined
    try {
      const cfg = loadConfig(CLAW_ROOT)
      delegateTimeoutMs = cfg.delegateTimeoutMs
      model = cfg.model
    } catch {
      console.log("[claw-core] no usable claw.json — delegation on server defaults")
    }
    const port = sessionControl(ctx.session as unknown as SessionApiLike)
    const json = (v: unknown) => JSON.stringify(v, null, 2)

    await ctx.tool.transform((draft) => {
      draft.add({
        name: "claw_probe",
        description: "Verify the claw-core plugin is alive inside a session",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "claw" },
        execute: async () => {
          return { content: `claw-core OK (OpenCode ${ctx.app.version})` }
        },
      })

      draft.add({
        name: "delegate",
        description:
          "Delegate one bounded sub-task to another agent (e.g. worker): a new session is created, the sub-task is prompted, and the worker's final answer is returned as this tool's result. Only the orchestrator may call this; worker sessions are refused (depth cap).",
        input: {
          type: "object",
          properties: {
            agent: { type: "string", description: 'Target agent id, e.g. "worker"' },
            task: { type: "string", description: "The bounded sub-task, self-contained instructions" },
          },
          required: ["agent", "task"],
          additionalProperties: false,
        },
        options: { namespace: "claw" },
        execute: async (input: { agent: string; task: string }, context) => {
          const out = await runDelegation(
            { port, db, clock: SystemClock, clawRoot: CLAW_ROOT, timeoutMs: delegateTimeoutMs, ...(model ? { model } : {}) },
            {
              parentSessionID: String(context.sessionID),
              parentAgent: String(context.agent),
              agent: input.agent,
              task: input.task,
            },
          )
          return { content: out.output, metadata: { ok: out.ok, taskId: out.taskId, sessionID: out.sessionID } }
        },
      })

      draft.add({
        name: "task_create",
        description: "Create a durable Claw task row (queued). Use for follow-ups that must outlive the session.",
        input: {
          type: "object",
          properties: {
            type: { type: "string", description: 'Task kind, e.g. "follow-up"' },
            payload: { type: "object", description: "Arbitrary JSON payload", additionalProperties: true },
          },
          required: ["type"],
          additionalProperties: false,
        },
        options: { namespace: "claw" },
        execute: async (input: { type: string; payload?: Record<string, unknown> }) => ({
          content: json(taskSummary(taskCreate(db, SystemClock, { type: input.type, payload: input.payload }))),
        }),
      })

      draft.add({
        name: "task_list",
        description: "List Claw tasks (newest first), optionally filtered by status or type.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", description: "queued | running | done | failed" },
            type: { type: "string" },
            limit: { type: "number", description: "Max rows (default 50)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "claw" },
        execute: async (input: { status?: string; type?: string; limit?: number }) => ({
          content: json(taskList(db, input ?? {}).map(taskSummary)),
        }),
      })

      draft.add({
        name: "task_update",
        description: "Move a Claw task to running/done/failed, recording an error or result.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", description: "running | done | failed" },
            error: { type: "string" },
            result: { description: "Arbitrary JSON result (for done)" },
          },
          required: ["id", "status"],
          additionalProperties: false,
        },
        options: { namespace: "claw" },
        execute: async (input: { id: string; status: "running" | "done" | "failed"; error?: string; result?: unknown }) => ({
          content: json(taskSummary(taskUpdate(db, SystemClock, input))),
        }),
      })
    })

    if (!existsSync(path.join(CLAW_ROOT, "claw.json"))) {
      console.log("[claw-core] note: no claw.json — scheduler config absent, tools still active")
    }

    // Later tickets register the session-context + permission-evaluation
    // hooks here (tickets 06/08).
    return () => {
      db.close()
      console.log("[claw-core] unloaded")
    }
  },
})
