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

async function runTick(deps: SchedulerDeps): Promise<TickResult> {
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
  const now = deps.clock.now()

  // Kill-switch first: nothing is read, claimed, or written while halted.
  if (existsSync(deps.killSwitchPath)) {
    log("kill-switch present — dispatch skipped this tick")
    return { killed: true, skipped: false, dispatched: [] }
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
  for (const s of deps.config.schedules) {
    if (!s.enabled) continue
    if (!isDue(state.get(s.id)?.lastDispatchedAt ?? null, s.cadenceMs, now)) continue

    // Claim durably BEFORE dispatching: task row (queued → running) and the
    // schedule's last_dispatched_at. If we die mid-prompt, the next daemon
    // life sees an in-flight task and a fresh claim — no duplicate dispatch.
    const task = deps.db.createTask(
      { type: "watchdog", payload: { scheduleId: s.id, repo: s.repo } },
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
      await deps.port.prompt(sessionID, s.prompt)
      dispatched.push({ scheduleId: s.id, taskId: task.id, sessionID })
      log(`dispatched ${s.id} → session ${sessionID} (task ${task.id})`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.db.finishTask(task.id, "failed", { error: msg }, deps.clock.now())
      log(`dispatch FAILED for ${s.id}: ${msg}`)
    }
  }
  return { killed: false, skipped: false, dispatched }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let running = false
  let stopped = false

  const tick = async (): Promise<TickResult> => {
    if (running) return { killed: false, skipped: true, dispatched: [] }
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
        if (stopped) break
        await deps.clock.sleep(deps.config.tickMs)
      }
    },
    stop() {
      stopped = true
    },
  }
}
