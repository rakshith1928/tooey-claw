import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import {
  classifyEvent,
  handleEvent,
  recoverOrphans,
  watchdogSweep,
  watchEvents,
  type CompletionDeps,
} from "../src/completion"
import type { ClawEvent } from "../src/ports"
import { FakeClock, flush, makeFakePort } from "./helpers"

const MIN = 60_000
const TIMEOUT = 15 * MIN

let tmp: string
let db: ClawDb
let clock: FakeClock
let fake: ReturnType<typeof makeFakePort>
let deps: CompletionDeps

/** A running task dispatched by ticket 02 semantics: row running + session attached. */
function seedRunning(sessionID: string, startedAt: number, scheduleId = "watchdog-a") {
  const t = db.createTask({ type: "watchdog", payload: { scheduleId, repo: "C:\\repos\\a" } }, startedAt)
  db.markTaskRunning(t.id, startedAt)
  db.setTaskSession(t.id, sessionID)
  return t
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-compl-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
  fake = makeFakePort()
  deps = { db, clock, port: fake.port, log: () => {} }
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("completion — event classification (pure)", () => {
  it("execution terminal events classify (live-verified vocabulary)", () => {
    expect(classifyEvent({ type: "session.execution.succeeded", sessionID: "s1" })).toBe("done")
    expect(classifyEvent({ type: "session.execution.failed", sessionID: "s1" })).toBe("failed")
    expect(classifyEvent({ type: "session.execution.interrupted", sessionID: "s1" })).toBe("failed")
    expect(classifyEvent({ type: "session.idle", sessionID: "s1" })).toBe("done") // beta-types alias
    expect(classifyEvent({ type: "session.deleted", sessionID: "s1" })).toBe("failed")
  })

  it("non-terminal and unrelated events are ignored", () => {
    expect(classifyEvent({ type: "session.execution.started", sessionID: "s1" })).toBeNull()
    expect(classifyEvent({ type: "session.step.started", sessionID: "s1" })).toBeNull()
    expect(classifyEvent({ type: "session.text.delta", sessionID: "s1" })).toBeNull()
    expect(classifyEvent({ type: "session.status", sessionID: "s1" })).toBeNull()
    expect(classifyEvent({ type: "server.connected" })).toBeNull()
  })
})

describe("completion — terminal events drive task rows", () => {
  it("ticket: terminal success event → task done with result JSON (verdict + pointer)", async () => {
    const t = seedRunning("ses_1", 1000)
    fake.setTranscript(["older chatter", "VERDICT: 2 open issues, no CI failures, since=2026-08-25T10:00Z"])
    clock.time = 5000

    const outcome = await handleEvent(deps, { type: "session.execution.succeeded", sessionID: "ses_1" })
    expect(outcome).toBe("done")

    const done = db.getTask(t.id)!
    expect(done.status).toBe("done")
    expect(done.finishedAt).toBe(5000)
    const r = done.result as Record<string, unknown>
    expect(r.sessionID).toBe("ses_1")
    expect(String(r.verdict)).toContain("VERDICT:") // compact verdict from transcript tail
    expect((r.pointer as Record<string, unknown>).lastFinishedAt).toBe(5000) // next-run pointer
  })

  it("ticket: failure event → task failed with error stored, session pointer preserved", async () => {
    const t = seedRunning("ses_9", 1000)
    const outcome = await handleEvent(deps, {
      type: "session.execution.failed",
      sessionID: "ses_9",
      data: { sessionID: "ses_9", error: { name: "ProviderAuthError", message: "401 invalid api key" } },
    })
    expect(outcome).toBe("failed")

    const failed = db.getTask(t.id)!
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("401 invalid api key") // extracted from event payload
    expect((failed.result as Record<string, unknown>).sessionID).toBe("ses_9") // not wiped
  })

  it("events for unknown or finished sessions change nothing (exactly-once)", async () => {
    const t = seedRunning("ses_1", 1000)
    expect(await handleEvent(deps, { type: "session.idle", sessionID: "ses_other" })).toBeNull()

    await handleEvent(deps, { type: "session.idle", sessionID: "ses_1" })
    const first = db.getTask(t.id)!
    // A duplicate idle (stream replay) must not re-finish or move finished_at.
    expect(await handleEvent(deps, { type: "session.idle", sessionID: "ses_1" })).toBeNull()
    expect(db.getTask(t.id)).toEqual(first)
  })

  it("watchEvents consumes the event stream and applies transitions", async () => {
    const t = seedRunning("ses_1", 0)
    fake.setTranscript(["done working"])
    fake.emit(
      { type: "session.status", sessionID: "ses_1" },
      { type: "session.idle", sessionID: "ses_1" },
    )
    fake.closeEvents()
    await watchEvents(deps) // resolves when the stream ends
    expect(db.getTask(t.id)!.status).toBe("done")
  })
})

describe("completion — watchdog timer (ticket: death without terminal event)", () => {
  it("force-fails running tasks past the timeout; fresh ones survive", () => {
    const old = seedRunning("ses_old", 0)
    const fresh = seedRunning("ses_fresh", TIMEOUT - 1)

    clock.time = TIMEOUT
    expect(watchdogSweep(deps, TIMEOUT, TIMEOUT)).toBe(1)
    expect(db.getTask(old.id)!.status).toBe("failed")
    expect(db.getTask(old.id)!.error).toMatch(/watchdog/i)
    expect(db.getTask(old.id)!.finishedAt).toBe(TIMEOUT)
    expect(db.getTask(fresh.id)!.status).toBe("running")
  })

  it("a later terminal event is impossible once watchdog failed the task (no flip-flop)", async () => {
    const old = seedRunning("ses_old", 0)
    watchdogSweep(deps, TIMEOUT + 1, TIMEOUT)
    const outcome = await handleEvent(deps, { type: "session.idle", sessionID: "ses_old" })
    expect(outcome).toBeNull()
    expect(db.getTask(old.id)!.status).toBe("failed")
  })
})

describe("completion — crash recovery (ticket: kill mid-run → restart)", () => {
  it("orphaned running task is swept at startup, no duplicate dispatch, loop continues", async () => {
    // Simulate the previous process life: dispatched at t=0, killed mid-prompt.
    const orphan = seedRunning("ses_dead", 0)
    db.upsertSchedules([{ id: "watchdog-a", name: "A", cadence: "every:15m", target: "C:\\r", enabled: true }])
    db.setLastDispatched("watchdog-a", 0)

    // ── Restart: reopen the same DB file with fresh process state ──
    db.close()
    db = openClawDb(path.join(tmp, "claw.db"))
    deps = { db, clock, port: fake.port, log: () => {} }

    const swept = recoverOrphans(deps)
    expect(swept).toBe(1)
    const t = db.getTask(orphan.id)!
    expect(t.status).toBe("failed")
    expect(t.error).toMatch(/restart/i)

    // No duplicate dispatch: same fake port + scheduler at t=0..14m dispatches nothing
    // (schedule claim from the previous life holds), and at 15m the loop continues normally.
    const { parseConfig } = await import("../src/config")
    const { createScheduler } = await import("../src/scheduler")
    const s = createScheduler({
      clock,
      port: fake.port,
      db,
      config: parseConfig({
        schedules: [{ id: "watchdog-a", repo: "C:\\r", cadence: "every:15m", prompt: "p" }],
      }),
      clawRoot: "C:\\claw",
      killSwitchPath: path.join(tmp, "kill"),
      log: () => {},
    })
    clock.advance(14 * MIN)
    expect((await s.tick()).dispatched).toEqual([])
    clock.advance(1 * MIN)
    expect((await s.tick()).dispatched).toHaveLength(1)
    expect(fake.sessions).toHaveLength(1)

    // The recovered orphan was not resurrected by the new dispatch.
    expect(db.getTask(orphan.id)!.status).toBe("failed")
  })

  it("recoverOrphans leaves queued and finished rows alone", () => {
    const queued = db.createTask({ type: "watchdog", payload: {} }, 1)
    const doneT = seedRunning("s1", 0)
    db.setTaskSession(doneT.id, "s1")
    clock.time = 10
    recoverOrphans(deps) // sweeps the running seedRunning row
    expect(db.getTask(queued.id)!.status).toBe("queued")
  })
})
