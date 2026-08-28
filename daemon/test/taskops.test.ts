import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import { taskCreate, taskList, taskUpdate } from "../src/taskops"
import { FakeClock } from "./helpers"

let tmp: string
let db: ClawDb
let clock: FakeClock

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-taskops-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("task tools — agent-session round-trip (ticket checkbox 5)", () => {
  it("create → list → update(round-trip through every status) → list", () => {
    const t = taskCreate(db, clock, { type: "follow-up", payload: { note: "check flaky test" } })
    expect(t.id).toBeTruthy()
    expect(t.status).toBe("queued")

    const listed = taskList(db, {})
    expect(listed.map((x) => x.id)).toEqual([t.id])

    const running = taskUpdate(db, clock, { id: t.id, status: "running" })
    expect(running.status).toBe("running")
    expect(running.startedAt).toBe(clock.now())

    const done = taskUpdate(db, clock, { id: t.id, status: "done", result: { verdict: "flaked once" } })
    expect(done.status).toBe("done")
    expect(done.result).toEqual({ verdict: "flaked once" })

    expect(taskList(db, { status: "done" }).map((x) => x.id)).toEqual([t.id])
    expect(taskList(db, { status: "queued" })).toHaveLength(0)
  })

  it("update to a failed status records the error", () => {
    const t = taskCreate(db, clock, { type: "check", payload: {} })
    const failed = taskUpdate(db, clock, { id: t.id, status: "failed", error: "gave up" })
    expect(failed.error).toBe("gave up")
  })

  it("unknown ids and invalid statuses are rejected", () => {
    expect(() => taskUpdate(db, clock, { id: "nope", status: "done" })).toThrow(/not found/i)
    const t = taskCreate(db, clock, { type: "check", payload: {} })
    expect(() => taskUpdate(db, clock, { id: t.id, status: "paused" as "done" })).toThrow()
  })

  it("list filters by type and caps at limit (newest first)", () => {
    for (let i = 0; i < 3; i++) {
      clock.advance(1)
      taskCreate(db, clock, { type: i === 2 ? "other" : "check", payload: { i } })
    }
    expect(taskList(db, { type: "check" })).toHaveLength(2)
    const capped = taskList(db, { limit: 2 })
    expect(capped).toHaveLength(2)
    expect((capped[0]!.payload as { i: number }).i).toBe(2) // newest first
  })
})
