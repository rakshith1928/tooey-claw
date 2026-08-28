/**
 * Completion detection & crash recovery (ticket 03, SPEC decision 10).
 *
 * Task rows are finished by REAL session lifecycle events, never guessed
 * timers, with two guards:
 * - watchdogSweep: force-fails running tasks past their timeout — covers
 *   sessions that died (or retry-loop) without any terminal event;
 * - recoverOrphans: on daemon startup, running rows from the previous
 *   process life are swept so crashes leave no orphans (the OpenCode
 *   service outlives the daemon, but our tracking does not).
 *
 * All timing comes from the injected Clock; completion is exactly-once by
 * construction: only a `running` row can transition, and lookups are by id.
 */
import type { ClawDb, Task } from "./db"
import type { ClawEvent, Clock, ClawOpenCodePort } from "./ports"

export interface CompletionDeps {
  db: ClawDb
  clock: Clock
  port: ClawOpenCodePort
  log?: (msg: string) => void
}

const VERDICT_MAX_CHARS = 2000

/**
 * Lifecycle vocabulary verified LIVE against the beta server (firewall normalizes):
 * a scheduled prompt terminates as session.execution.succeeded / .failed /
 * .interrupted; .deleted covers session death; session.idle (beta types) kept
 * as a defensive alias — exactly-once row semantics make overlap harmless.
 */
export function classifyEvent(ev: ClawEvent): "done" | "failed" | null {
  switch (ev.type) {
    case "session.execution.succeeded":
    case "session.idle":
      return "done"
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.deleted":
      return "failed"
    default:
      return null
  }
}

/** Compact failure reason from the event payload (beta shape: { error } or { reason }). */
function failureReason(ev: ClawEvent): string {
  const data = ev.data ?? {}
  if (typeof data.reason === "string") return `execution interrupted: ${data.reason}`
  const err = data.error
  if (typeof err === "string") return err.slice(0, VERDICT_MAX_CHARS)
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>
    const msg = typeof o.message === "string" ? o.message : JSON.stringify(o)
    return msg.slice(0, VERDICT_MAX_CHARS)
  }
  return `session ${ev.sessionID} terminated without success (${ev.type})`
}

/**
 * Apply one event to task state. Returns the transition applied, or null
 * when the event is irrelevant or belongs to a session with no running task
 * (covers stream replays: a second idle finds no running row → no-op).
 */
export async function handleEvent(
  deps: CompletionDeps,
  ev: ClawEvent,
): Promise<"done" | "failed" | null> {
  const kind = classifyEvent(ev)
  if (!kind || !ev.sessionID) return null
  const task = deps.db.findRunningBySession(ev.sessionID)
  if (!task) return null
  const now = deps.clock.now()
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))

  if (kind === "done") {
    const lines = await deps.port.transcript(ev.sessionID).catch(() => [])
    const verdict = (lines.at(-1) ?? "").slice(0, VERDICT_MAX_CHARS)
    deps.db.finishTask(
      task.id,
      "done",
      {
        result: {
          sessionID: ev.sessionID,
          verdict,
          // Compact next-run pointer: incremental runs read `previous.pointer`.
          pointer: { lastFinishedAt: now },
        },
      },
      now,
    )
    log(`task ${task.id} done (session ${ev.sessionID})`)
    return "done"
  }

  deps.db.finishTask(task.id, "failed", { error: failureReason(ev) }, now)
  log(`task ${task.id} failed (${failureReason(ev)})`)
  return "failed"
}

/** Consume the server event stream until it ends. */
export async function watchEvents(deps: CompletionDeps): Promise<void> {
  for await (const ev of deps.port.events()) {
    try {
      await handleEvent(deps, ev)
    } catch (error) {
      // The watcher must outlive any single bad event.
      const msg = error instanceof Error ? error.message : String(error)
      const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
      log(`completion watcher: ignored event error: ${msg}`)
    }
  }
}

/** Force-fail running tasks older than `timeoutMs`. Returns how many. */
export function watchdogSweep(deps: CompletionDeps, now: number, timeoutMs: number): number {
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
  let swept = 0
  for (const task of deps.db.listRunning()) {
    const started = task.startedAt ?? task.createdAt
    if (now - started < timeoutMs) continue
    deps.db.finishTask(
      task.id,
      "failed",
      { error: `watchdog: no terminal event within ${Math.round(timeoutMs / 1000)}s` },
      now,
    )
    log(`task ${task.id} force-failed by watchdog`)
    swept++
  }
  return swept
}

/**
 * Startup sweep (kill-mid-run recovery): every running row belongs to the
 * previous process life — we lost its event subscription. Fail them; the
 * schedule claim (last_dispatched_at) prevents duplicate dispatch.
 */
export function recoverOrphans(deps: CompletionDeps, now?: number): number {
  const t = now ?? deps.clock.now()
  const log = deps.log ?? ((m: string) => console.log(`[claw] ${m}`))
  let swept = 0
  for (const task of deps.db.listRunning()) {
    deps.db.finishTask(task.id, "failed", { error: "orphaned: daemon restarted while task was running" }, t)
    log(`recovered orphaned task ${task.id} (running at daemon restart)`)
    swept++
  }
  return swept
}

/** Compact pointer payload for the NEXT dispatch of a schedule (decision 11). */
export function previousResult(db: ClawDb, scheduleId: string): unknown {
  const last: Task | null = db.lastDoneFor(scheduleId)
  return last?.result ?? null
}
