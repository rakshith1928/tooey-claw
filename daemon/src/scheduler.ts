/**
 * Scheduler & dispatch skeleton (ticket 02, SPEC decision 9).
 *
 * Rules encoded here:
 * - every timing decision comes from the injected Clock — never raw wall time;
 * - a due schedule dispatches exactly once: the schedule row is claimed
 *   (last_dispatched_at) and a durable task row is created + flipped to
 *   `running` BEFORE any side effect on the port, so a crash never duplicates;
 * - one single-flight lock guards the loop against overlapping runs;
 * - the kill-switch sentinel is checked first thing every tick (decision 12).
 */
import { existsSync } from "node:fs"
import type { ClawConfig } from "./config"
import { previousResult } from "./completion"
import type { ClawDb } from "./db"
import type { Clock, ClawOpenCodePort } from "./ports"

export interface SchedulerDeps {
  clock: Clock
  port: ClawOpenCodePort
  db: ClawDb
  config: ClawConfig
  /** Sessions are rooted here so Claw agents/plugins apply (SPEC decision 3). */
  clawRoot: string
  killSwitchPath: string
  log?: (msg: string) => void
  /** Runs after every tick (even killed ones) — production uses it for the watchdog sweep. */
  afterTick?: (now: number) => void
}

export interface DispatchRecord {
  scheduleId: string
  taskId: string
  sessionID: string
}

export interface TickResult {
  killed: boolean
  skipped: boolean
  dispatched: DispatchRecord[]
  /** Schedules that were due but held back because a previous run is still in flight. */
  inFlight: string[]
}

export interface Scheduler {
  tick(): Promise<TickResult>
  /** tick → clock.sleep(tickMs) → repeat, until stop(). */
  runLoop(): Promise<void>
  stop(): void
}

function isDue(lastDispatchedAt: number | null, cadenceMs: number, now: number): boolean {
  return lastDispatchedAt === null || now - lastDispatchedAt >= cadenceMs
}

/**
 * Render the dispatch prompt (ticket 05): the user's config prompt, plus —
 * when a previous run's compact result exists — a PREVIOUS RUN section with
 * the verdict and the pointer JSON verbatim, so run N+1 is incremental by
 * construction ("since last time") without any tool calls.
 */
export function renderPrompt(userPrompt: string, previous: unknown): string {
  if (previous === null || previous === undefined) return userPrompt
  return [
    userPrompt,
    "",
    "--- PREVIOUS RUN (incremental context: act on what changed SINCE this) ---",
    `VERDICT: ${String((previous as { verdict?: unknown }).verdict ?? "(none recorded)")}`,
    `POINTER: ${JSON.stringify((previous as { pointer?: unknown }).pointer ?? null)}`,
    "--- END PREVIOUS RUN ---",
  ].join("\n")
}

async function runTick(deps: SchedulerDeps): Promise<TickResult> {
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
  const now = deps.clock.now()

  // Kill-switch first: nothing is read, claimed, or written while halted.
  if (existsSync(deps.killSwitchPath)) {
    log("kill-switch present — dispatch skipped this tick")
    return { killed: true, skipped: false, dispatched: [], inFlight: [] }
  }

  // Config is the source of truth; the DB row owns last_dispatched_at.
  deps.db.upsertSchedules(
    deps.config.schedules.map((s) => ({
      id: s.id,
      name: s.name,
      cadence: s.cadence,
      target: s.repo,
      enabled: s.enabled,
    })),
  )
  const state = new Map(deps.db.listSchedules().map((r) => [r.id, r]))

  const dispatched: DispatchRecord[] = []
  const inFlight: string[] = []
  for (const s of deps.config.schedules) {
    if (!s.enabled) continue
    if (!isDue(state.get(s.id)?.lastDispatchedAt ?? null, s.cadenceMs, now)) continue

    // In-flight guard (ticket 05): never stack a second run for a schedule
    // whose previous run is still executing — incremental runs need the
    // previous verdict, and stacking would also duplicate work on slow repos.
    if (deps.db.findRunningForSchedule(s.id)) {
      log(`${s.id}: previous run still in flight — holding this dispatch`)
      inFlight.push(s.id)
      continue
    }

    // Claim durably BEFORE dispatching: task row (queued → running) and the
    // schedule's last_dispatched_at. If we die mid-prompt, the next daemon
    // life sees an in-flight task and a fresh claim — no duplicate dispatch.
    // Payload carries the previous run's compact result (decision 11): the
    // orchestrator prompt reads `previous.pointer` for incremental checks.
    const previous = previousResult(deps.db, s.id)
    const task = deps.db.createTask(
      {
        type: "watchdog",
        payload: { scheduleId: s.id, repo: s.repo, previous },
      },
      now,
    )
    deps.db.markTaskRunning(task.id, now)
    deps.db.setLastDispatched(s.id, now)

    try {
      const { sessionID } = await deps.port.createSession({
        directory: deps.clawRoot,
        agent: "claw",
        title: `scheduled: ${s.name}`,
        ...(deps.config.model ? { model: deps.config.model } : {}),
      })
      deps.db.setTaskSession(task.id, sessionID)
      // The prompt inlines the previous verdict + pointer so the orchestrator
      // acts incrementally ("since last time") with zero tool calls.
      await deps.port.prompt(sessionID, renderPrompt(s.prompt, previous))
      dispatched.push({ scheduleId: s.id, taskId: task.id, sessionID })
      log(`dispatched ${s.id} → session ${sessionID} (task ${task.id})${previous ? " [incremental]" : ""}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.db.finishTask(task.id, "failed", { error: msg }, deps.clock.now())
      log(`dispatch FAILED for ${s.id}: ${msg}`)
    }
  }
  return { killed: false, skipped: false, dispatched, inFlight }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let running = false
  let stopped = false

  const tick = async (): Promise<TickResult> => {
    if (running) return { killed: false, skipped: true, dispatched: [], inFlight: [] }
    running = true
    try {
      return await runTick(deps)
    } finally {
      running = false
    }
  }

  return {
    tick,
    async runLoop() {
      stopped = false
      while (!stopped) {
        await tick()
        // Reconciliation is not dispatch: the watchdog sweeps even while the
        // kill-switch halts new work, so in-flight tasks still get resolved.
        deps.afterTick?.(deps.clock.now())
        if (stopped) break
        await deps.clock.sleep(deps.config.tickMs)
      }
    },
    stop() {
      stopped = true
    },
  }
}
