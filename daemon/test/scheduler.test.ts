import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import { parseConfig, type ClawConfig } from "../src/config"
import { createScheduler, type TickResult } from "../src/scheduler"
import { FakeClock, flush, makeFakePort } from "./helpers"

const MIN = 60_000

let tmp: string
let db: ClawDb
let clock: FakeClock
let fake: ReturnType<typeof makeFakePort>
let killPath: string

function config(over: Partial<ClawConfig> = {}): ClawConfig {
  return parseConfig({
    tickSeconds: 60,
    schedules: [
      {
        id: "watchdog-a",
        name: "Watch A",
        repo: "C:\\repos\\a",
        cadence: "every:15m",
        prompt: "Check repo A since last run.",
      },
    ],
    ...over,
  })
}

function scheduler(cfg = config()) {
  return createScheduler({
    clock,
    port: fake.port,
    db,
    config: cfg,
    clawRoot: "C:\\claw",
    killSwitchPath: killPath,
    log: () => {},
  })
}

/** Finish run 1 like the ticket-03 event watcher would. */
function completeFirstRun() {
  const rows = db.queryAll<{ id: string }>("SELECT id FROM tasks ORDER BY created_at")
  db.finishTask(rows[0]!.id, "done", { result: { verdict: "ok" } }, clock.now())
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-sched-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
  fake = makeFakePort()
  killPath = path.join(tmp, "kill")
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("scheduler — due dispatch (ticket: due schedule dispatches exactly once)", () => {
  it("first tick dispatches a due schedule once; re-tick at same time does not duplicate", async () => {
    const s = scheduler()
    const r1 = await s.tick()
    expect(r1.dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])

    const r2 = await s.tick() // same clock time — must not fire again
    expect(r2.dispatched).toEqual([])
    expect(fake.sessions).toHaveLength(1)
    expect(fake.prompts).toHaveLength(1)
  })

  it("fires again exactly when the cadence elapses, not before", async () => {
    const s = scheduler()
    await s.tick() // t=0 dispatches

    clock.advance(14 * MIN)
    expect((await s.tick()).dispatched).toEqual([]) // not yet due

    clock.advance(1 * MIN) // t=15m exactly
    // Previous run still in flight → held (ticket 05 in-flight guard).
    expect((await s.tick()).dispatched).toEqual([])
    completeFirstRun()
    expect((await s.tick()).dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])
    expect(fake.sessions).toHaveLength(2)
  })

  it("ticket: a not-yet-due schedule does not fire (fresh, within window)", async () => {
    // Schedule already dispatched in a previous daemon life at t=-10m, cadence 15m.
    const s = scheduler()
    await s.tick() // t=0, sets last_dispatched_at=0
    clock.advance(10 * MIN)
    const r = await s.tick()
    expect(r.dispatched).toEqual([])
    expect(fake.sessions).toHaveLength(1)
  })

  it("disabled schedules never fire", async () => {
    const s = scheduler(
      parseConfig({
        schedules: [
          { id: "off", repo: "C:\\r", cadence: "every:1m", prompt: "p", enabled: false },
        ],
      }),
    )
    expect((await s.tick()).dispatched).toEqual([])
    expect(fake.sessions).toHaveLength(0)
  })
})

describe("scheduler — durable task row (ticket: running before prompt)", () => {
  it("creates the task row and flips it to running BEFORE the prompt is dispatched", async () => {
    const seenStatuses: string[] = []
    fake.beforePrompt(() => {
      const rows = db.queryAll<{ status: string }>("SELECT status FROM tasks")
      seenStatuses.push(...rows.map((r) => r.status))
    })
    await scheduler().tick()

    expect(seenStatuses).toEqual(["running"]) // row exists & running at dispatch time
    const t = db.queryAll<{ status: string; type: string; result_json: string }>(
      "SELECT status, type, result_json FROM tasks",
    )[0]!
    expect(t.type).toBe("watchdog")
    expect(t.status).toBe("running") // still running — completion is ticket 03
    expect(JSON.parse(t.result_json).sessionID).toBe("ses_1") // session recorded on the row
  })

  it("persists last_dispatched_at so a restart does not duplicate", async () => {
    await scheduler().tick()
    // Simulate daemon restart: same DB, fresh scheduler + fresh clock past cadence.
    db.close()
    db = openClawDb(path.join(tmp, "claw.db"))
    const fake2 = makeFakePort()
    const s2 = createScheduler({
      clock,
      port: fake2.port,
      db,
      config: config(),
      clawRoot: "C:\\claw",
      killSwitchPath: killPath,
      log: () => {},
    })
    clock.advance(14 * MIN) // still inside the 15m window from t=0
    expect((await s2.tick()).dispatched).toEqual([])
    expect(fake2.sessions).toHaveLength(0)
  })
})

describe("scheduler — session shape", () => {
  it("dispatches an orchestrator session rooted at the Claw dir with the schedule prompt", async () => {
    await scheduler().tick()
    expect(fake.sessions[0]).toEqual({
      directory: "C:\\claw",
      agent: "claw",
      title: "scheduled: Watch A",
    })
    expect(fake.prompts[0]!.text).toBe("Check repo A since last run.")
  })

  it("passes the configured dispatch model so unattended runs pin their model", async () => {
    const cfg = parseConfig({
      model: "openrouter/openrouter/free",
      schedules: [{ id: "m", repo: "C:\\r", cadence: "every:1m", prompt: "p" }],
    })
    await scheduler(cfg).tick()
    expect(fake.sessions[0]).toEqual({
      directory: "C:\\claw",
      agent: "claw",
      title: "scheduled: m",
      model: { providerID: "openrouter", modelID: "openrouter/free" },
    })
  })
})

describe("scheduler — single-flight lock (ticket: blocks a second concurrent run)", () => {
  it("a second tick while the first is mid-dispatch is skipped, no duplicate session", async () => {
    const s = scheduler()
    const gate = fake.armGate() // next prompt() blocks until opened
    const first = s.tick() // will block inside prompt() on the gate
    await flush() // let it reach prompt()
    const second: TickResult = await s.tick()

    expect(second.skipped).toBe(true)
    expect(second.dispatched).toEqual([])

    gate.open()
    const r1 = await first
    expect(r1.dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])
    expect(fake.sessions).toHaveLength(1) // never two sessions for one due window

    // After the first run completes, the lock is released.
    clock.advance(15 * MIN)
    completeFirstRun() // ticket 03 finishes run 1; until then the guard holds
    const third = await s.tick()
    expect(third.skipped).toBeFalsy()
    expect(third.dispatched).toHaveLength(1)
  })

  it("ticket: in-flight guard — a due schedule with a still-running previous task does not double-dispatch", async () => {
    const s = scheduler()
    await s.tick() // run 1 dispatched at t=0, never completed

    clock.advance(15 * MIN) // cadence fully elapsed while run 1 still running
    const r2 = await s.tick()
    expect(r2.dispatched).toEqual([]) // no second session while one is in flight
    expect(fake.sessions).toHaveLength(1)
    expect(r2.inFlight).toEqual(["watchdog-a"]) // surfaced, not silent

    // The run completes out-of-band (event watcher) → the next tick can dispatch.
    const rows = db.queryAll<{ id: string }>("SELECT id FROM tasks ORDER BY created_at")
    db.finishTask(rows[0]!.id, "done", { result: { verdict: "ok" } }, clock.now())
    const r3 = await s.tick() // same clock time: dispatch was only blocked by in-flight
    expect(r3.dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])
    expect(fake.sessions).toHaveLength(2)
  })

  it("ticket: run 2's PROMPT carries run 1's result — incremental 'since' runs (decision 11)", async () => {
    const s = scheduler()
    await s.tick() // run 1 at t=0
    const rows = db.queryAll<{ id: string }>("SELECT id FROM tasks ORDER BY created_at")
    db.finishTask(
      rows[0]!.id,
      "done",
      { result: { sessionID: "ses_1", verdict: "3 open issues", pointer: { lastFinishedAt: 0, seen: "issue-9" } } },
      60_000,
    )

    clock.advance(15 * MIN)
    await s.tick() // run 2

    // Payload AND prompt both carry the previous result: the orchestrator
    // sees "since" without any tool call.
    const payload2 = JSON.parse(
      db.queryAll<{ payload_json: string }>("SELECT payload_json FROM tasks ORDER BY created_at")[1]!.payload_json,
    )
    expect(payload2.previous.pointer).toEqual({ lastFinishedAt: 0, seen: "issue-9" })

    const prompt2 = fake.prompts[1]!.text
    expect(prompt2).toContain("Check repo A since last run.") // user prompt intact
    expect(prompt2).toContain("VERDICT: 3 open issues") // previous verdict inlined
    expect(prompt2).toContain('"lastFinishedAt":0') // pointer serialized verbatim

    // Run 1 (no previous) prompts without the injected section.
    expect(fake.prompts[0]!.text).not.toContain("VERDICT")
  })

  it("ticket: failed previous run does not block the next dispatch (in-flight guard is running-only)", async () => {
    const s = scheduler()
    await s.tick()
    const rows = db.queryAll<{ id: string }>("SELECT id FROM tasks ORDER BY created_at")
    db.finishTask(rows[0]!.id, "failed", { error: "watchdog timeout" }, clock.now())

    clock.advance(15 * MIN)
    const r2 = await s.tick()
    expect(r2.dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])
    const payload2 = JSON.parse(
      db.queryAll<{ payload_json: string }>("SELECT payload_json FROM tasks ORDER BY created_at")[1]!.payload_json,
    )
    expect(payload2.previous).toBeNull() // failed run leaves no pointer
  })
})

describe("scheduler — kill switch (ticket: halts dispatch within one tick, resumes on removal)", () => {
  it("kill file present → tick performs no dispatch; removing it → next tick dispatches", async () => {
    const s = scheduler()
    writeFileSync(killPath, "halted")
    expect(existsSync(killPath)).toBe(true)

    const r = await s.tick()
    expect(r.killed).toBe(true)
    expect(r.dispatched).toEqual([])
    expect(fake.sessions).toHaveLength(0)
    // Nothing was consumed OR written while killed: no task rows, no seeding.
    expect(db.queryAll("SELECT id FROM tasks")).toHaveLength(0)
    expect(db.listSchedules()).toHaveLength(0)

    // Time passing while killed does not "bank up" extra dispatches.
    clock.advance(40 * MIN)
    expect((await s.tick()).dispatched).toEqual([])

    unlinkSync(killPath)
    const resumed = await s.tick()
    expect(resumed.killed).toBe(false)
    expect(resumed.dispatched.map((d) => d.scheduleId)).toEqual(["watchdog-a"])
    expect(fake.sessions).toHaveLength(1) // exactly one, not one-per-skipped-tick
  })
})

describe("scheduler — runLoop (tick → sleep → tick, never raw wall time)", () => {
  it("loops on the fake clock and stops on stop()", async () => {
    const cfg = config() // tickMs = 60_000
    const s = scheduler(cfg)
    const done = s.runLoop()

    await flush() // first tick runs immediately
    expect(fake.sessions).toHaveLength(1)

    clock.advance(60_000) // one tick interval
    await flush()
    expect(fake.sessions).toHaveLength(1) // schedule not due again until 15m

    clock.advance(14 * MIN) // now past 15m total
    await flush()
    // Run 1 never completed in this fake loop → in-flight guard holds.
    expect(fake.sessions).toHaveLength(1)
    completeFirstRun()
    clock.advance(60_000) // next loop tick observes the completion
    await flush()
    expect(fake.sessions).toHaveLength(2)

    s.stop()
    clock.advance(60_000)
    await done // resolves once the loop notices the stop
    expect(fake.sessions).toHaveLength(2)
  })
})
