/**
 * Delegation path (ticket 04, SPEC decisions 8-9).
 *
 * `runDelegation` is the ONE implementation of what a delegate call means;
 * the plugin's `claw_delegate` tool is a thin adapter over it (in-server,
 * ctx.session-backed port), so every rule is proven at the daemon-loop seam
 * with the recording fake client:
 * - depth cap: only orchestrator agents may delegate (max depth 1 in scope);
 * - refusal and validation happen BEFORE any side effect;
 * - every delegation is a durable task row (`type: "delegate"`), so the
 *   ticket-03 watchdog and startup orphan sweep cover it too;
 * - the worker session is created in the Claw root (agents/plugins apply),
 *   pinned to the configured model, prompted, awaited, and interrupted +
 *   task-failed if it overruns the delegation budget.
 */
import type { ClawDb } from "./db"
import type { ClawOpenCodePort, Clock, ModelRef } from "./ports"

export interface DelegateDeps {
  /** Only the session-control slice is needed — plugin ctx provides exactly this. */
  port: Pick<ClawOpenCodePort, "createSession" | "prompt" | "wait" | "interrupt" | "transcript">
  db: ClawDb
  clock: Clock
  /** Worker sessions are created here so Claw agents/plugins apply (decision 3). */
  clawRoot: string
  timeoutMs: number
  model?: ModelRef
  /** Agents allowed to delegate (depth cap: their children may not). Default: ["claw"]. */
  allowedCallers?: string[]
  log?: (msg: string) => void
}

export interface DelegateCall {
  /** Session the tool was invoked from (ToolContext.sessionID). */
  parentSessionID: string
  /** Agent of the calling session (ToolContext.agent) — the depth-cap signal. */
  parentAgent: string
  /** Target agent, e.g. "worker". */
  agent: string
  /** Bounded sub-task text. */
  task: string
}

export interface DelegateOutcome {
  ok: boolean
  /** What comes back into the orchestrator's context as the tool result. */
  output: string
  taskId?: string
  sessionID?: string
}

const OUTPUT_MAX_CHARS = 8000
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export async function runDelegation(deps: DelegateDeps, call: DelegateCall): Promise<DelegateOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
  const callers = deps.allowedCallers ?? ["claw"]

  // Depth cap BEFORE any side effect: a worker delegating is the runaway-chain
  // case SPEC decision 9 guards against (max depth 1 in this scope).
  if (!callers.includes(call.parentAgent)) {
    const msg = `REFUSED: delegation depth cap (max 1) — agent '${call.parentAgent}' may not delegate`
    log(msg)
    return { ok: false, output: msg }
  }
  if (typeof call.task !== "string" || call.task.trim().length === 0) {
    return { ok: false, output: "REFUSED: delegation task must be a non-empty string" }
  }
  if (!AGENT_ID.test(call.agent)) {
    return { ok: false, output: `REFUSED: invalid agent id ${JSON.stringify(call.agent)}` }
  }

  const task = deps.db.createTask(
    {
      type: "delegate",
      payload: { parentSessionID: call.parentSessionID, parentAgent: call.parentAgent, agent: call.agent, task: call.task },
    },
    deps.clock.now(),
  )
  deps.db.markTaskRunning(task.id, deps.clock.now())

  try {
    const { sessionID } = await deps.port.createSession({
      directory: deps.clawRoot,
      agent: call.agent,
      title: `delegate: ${call.task.slice(0, 60)}`,
      ...(deps.model ? { model: deps.model } : {}),
    })
    deps.db.setTaskSession(task.id, sessionID)
    log(`delegating to ${call.agent}: session ${sessionID} (task ${task.id})`)

    await deps.port.prompt(sessionID, call.task)

    // Timeout-bounded wait: the budget is the Clock, so fake-clock tests
    // prove it without real sleeping.
    const outcome = await Promise.race([
      deps.port.wait(sessionID).then(() => "settled" as const),
      deps.clock.sleep(deps.timeoutMs).then(() => "timeout" as const),
    ])

    if (outcome === "timeout") {
      await deps.port.interrupt(sessionID).catch(() => {})
      const msg = `delegation to ${call.agent} timed out after ${Math.round(deps.timeoutMs / 1000)}s`
      deps.db.finishTask(task.id, "failed", { error: msg }, deps.clock.now())
      log(msg)
      return { ok: false, output: msg, taskId: task.id, sessionID }
    }

    const lines = await deps.port.transcript(sessionID)
    const verdict = (lines.at(-1) ?? "(worker produced no text)").slice(0, OUTPUT_MAX_CHARS)
    deps.db.finishTask(
      task.id,
      "done",
      { result: { sessionID, verdict, delegatedTo: call.agent } },
      deps.clock.now(),
    )
    log(`delegation ${task.id} done (worker ${sessionID})`)
    return { ok: true, output: verdict, taskId: task.id, sessionID }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    deps.db.finishTask(task.id, "failed", { error: msg }, deps.clock.now())
    log(`delegation ${task.id} failed: ${msg}`)
    return { ok: false, output: `delegation failed: ${msg}`, taskId: task.id }
  }
}
