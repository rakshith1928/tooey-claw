import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import { closeDb } from "./helpers"

let tmp: string
let db: ClawDb

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-db-"))
  db = openClawDb(path.join(tmp, "claw.db"))
})
afterEach(() => {
  closeDb(db)
  rmSync(tmp, { recursive: true, force: true })
})

describe("db — schema", () => {
  it("opens in WAL mode and creates tasks + schedules tables", () => {
    const journal = db.query1<{ journal_mode: string }>("PRAGMA journal_mode")
    expect(journal?.journal_mode.toLowerCase()).toBe("wal")
    const tables = db.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((r) => r.name)
    expect(tables).toContain("tasks")
    expect(tables).toContain("schedules")
  })

  it("reopening an existing db preserves rows (state survives restarts)", () => {
    const t = db.createTask({ type: "watchdog", payload: { repo: "x" } }, 1000)
    closeDb(db)
    db = openClawDb(path.join(tmp, "claw.db"))
    expect(db.getTask(t.id)?.status).toBe("queued")
  })
})

describe("db — task lifecycle", () => {
  it("createTask starts queued with created_at from the injected clock", () => {
    const t = db.createTask({ type: "watchdog", payload: { repo: "r", n: 1 } }, 42)
    expect(t.status).toBe("queued")
    expect(t.createdAt).toBe(42)
    expect(t.payload).toEqual({ repo: "r", n: 1 })
    expect(t.startedAt).toBeNull()
  })

  it("markRunning transitions queued → running and stamps started_at", () => {
    const t = db.createTask({ type: "watchdog", payload: {} }, 1)
    const r = db.markTaskRunning(t.id, 10)
    expect(r?.status).toBe("running")
    expect(r?.startedAt).toBe(10)
  })

  it("finish done/failed records result/error/finished_at", () => {
    const t = db.createTask({ type: "watchdog", payload: {} }, 1)
    db.markTaskRunning(t.id, 2)
    const done = db.finishTask(t.id, "done", { result: { verdict: "ok" } }, 3)
    expect(done?.status).toBe("done")
    expect(done?.result).toEqual({ verdict: "ok" })
    expect(done?.finishedAt).toBe(3)

    const f = db.createTask({ type: "watchdog", payload: {} }, 1)
    const failed = db.finishTask(f.id, "failed", { error: "boom" }, 5)
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toBe("boom")
  })

  it("finishTask without a new result PRESERVES the session pointer in result_json", () => {
    const t = db.createTask({ type: "watchdog", payload: {} }, 1)
    db.setTaskSession(t.id, "ses_42")
    const failed = db.finishTask(t.id, "failed", { error: "boom" }, 5)
    expect(failed?.error).toBe("boom")
    expect(failed?.result).toEqual({ sessionID: "ses_42" }) // not wiped
  })

  it("setTaskSession records the session on the row", () => {
    const t = db.createTask({ type: "watchdog", payload: {} }, 1)
    db.setTaskSession(t.id, "ses_7")
    expect(db.getTask(t.id)?.result).toEqual({ sessionID: "ses_7" })
  })

  it("finishTask allows done directly from queued and rejects non-terminal statuses", () => {
    const t = db.createTask({ type: "watchdog", payload: {} }, 1)
    const done = db.finishTask(t.id, "done", {}, 9)
    expect(done?.status).toBe("done")
    expect(() => db.finishTask(t.id, "running" as never, {}, 10)).toThrow()
  })
})

describe("db — schedule state", () => {
  it("upsertSchedules seeds rows with null last_dispatched_at", () => {
    db.upsertSchedules([
      { id: "s1", name: "one", cadence: "every:15m", target: "C:\\r1", enabled: true },
      { id: "s2", name: "two", cadence: "every:1h", target: "C:\\r2", enabled: false },
    ])
    const rows = db.listSchedules()
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"])
    expect(rows[0]?.lastDispatchedAt).toBeNull()
    expect(rows[1]?.enabled).toBe(false)
  })

  it("upsert is idempotent and PRESERVES last_dispatched_at across reseeds", () => {
    db.upsertSchedules([{ id: "s1", name: "one", cadence: "every:15m", target: "C:\\r1", enabled: true }])
    db.setLastDispatched("s1", 1234)
    db.upsertSchedules([{ id: "s1", name: "one-renamed", cadence: "every:20m", target: "C:\\r1", enabled: true }])
    const s = db.listSchedules()[0]!
    expect(s.name).toBe("one-renamed")
    expect(s.lastDispatchedAt).toBe(1234)
  })

  it("setLastDispatched on unknown id is a no-op (no throw)", () => {
    expect(() => db.setLastDispatched("ghost", 1)).not.toThrow()
  })
})
