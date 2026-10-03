import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb, type MemoryEntry } from "../src/db"
import { closeDb } from "./helpers"

/**
 * Ticket 07: persistent memory behind a narrow interface (save/search), FTS5
 * inside. Tests touch ONLY the public memory methods + a real temp DB file —
 * no OpenCode involvement. FTS specifics (MATCH, bm25, triggers) must not
 * appear in the interface or in these tests.
 */

let tmp: string
let dbFile: string
let db: ClawDb

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-mem-"))
  dbFile = path.join(tmp, "claw.db")
  db = openClawDb(dbFile)
})
afterEach(() => {
  closeDb(db)
  rmSync(tmp, { recursive: true, force: true })
})

describe("memory — save then keyword search (ticket: sensible ranking)", () => {
  it("returns the saved entry for a keyword query, best match first", () => {
    db.memorySave({ text: "postgres deadlock on the orders table during nightly vacuum", tags: ["postgres", "incident"] }, 1000)
    db.memorySave({ text: "lunch menu for friday team outing", tags: ["misc"] }, 2000)

    const hits = db.memorySearch("postgres deadlock")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.text).toContain("deadlock")
    expect(hits[0]!.tags).toEqual(["postgres", "incident"])
    expect(hits[0]!.createdAt).toBe(1000)
    expect(hits[0]!.id).toBeTruthy()
  })

  it("ranks higher term frequency above a single mention (BM25)", () => {
    db.memorySave({ text: "redis latency ok", tags: [] }, 1000)
    db.memorySave(
      { text: "redis latency alert: redis latency p99 high, check the redis latency dashboard", tags: [] },
      2000,
    )

    const hits = db.memorySearch("redis latency")
    expect(hits.map((h) => h.text)).toEqual([
      "redis latency alert: redis latency p99 high, check the redis latency dashboard",
      "redis latency ok",
    ])
  })

  it("queries with FTS5 special characters do not throw", () => {
    db.memorySave({ text: "deadlock in production (orders)", tags: [] }, 1000)
    expect(() => db.memorySearch('deadlock (production) "orders" AND/OR')).not.toThrow()
    const hits = db.memorySearch("deadlock production orders")
    expect(hits).toHaveLength(1)
  })

  it("empty query with no filters returns newest first, capped by limit", () => {
    db.memorySave({ text: "first", tags: [] }, 1000)
    db.memorySave({ text: "second", tags: [] }, 2000)
    const hits = db.memorySearch("", { limit: 1 })
    expect(hits.map((h) => h.text)).toEqual(["second"])
  })
})

describe("memory — tag-filtered search (ticket)", () => {
  it("narrows keyword results to entries carrying ALL given tags", () => {
    db.memorySave({ text: "postgres vacuum tuning notes", tags: ["postgres", "runbook"] }, 1000)
    db.memorySave({ text: "postgres outage postmortem", tags: ["postgres", "incident"] }, 2000)
    db.memorySave({ text: "unrelated incident without the keyword", tags: ["incident"] }, 3000)

    const hits = db.memorySearch("postgres", { tags: ["incident"] })
    expect(hits.map((h) => h.text)).toEqual(["postgres outage postmortem"])
  })

  it("tag-only search (no keywords) lists tagged entries newest first", () => {
    db.memorySave({ text: "old runbook", tags: ["runbook"] }, 1000)
    db.memorySave({ text: "new runbook", tags: ["runbook"] }, 2000)
    db.memorySave({ text: "untagged", tags: [] }, 3000)

    expect(db.memorySearch("", { tags: ["runbook"] }).map((h) => h.text)).toEqual(["new runbook", "old runbook"])
  })
})

describe("memory — restart semantics (ticket: close/reopen)", () => {
  it("entries survive close and reopen of the same DB file", () => {
    db.memorySave({ text: "survives restart verdict", tags: ["watchdog"] }, 1000)
    closeDb(db)
    db = openClawDb(dbFile) // simulated process restart

    const hits = db.memorySearch("survives restart", { tags: ["watchdog"] })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.text).toBe("survives restart verdict")
  })

  it("reopening twice applies migrations idempotently (no duplicate rows, no throw)", () => {
    db.memorySave({ text: "idempotent", tags: [] }, 1000)
    closeDb(db)
    db = openClawDb(dbFile)
    closeDb(db)
    db = openClawDb(dbFile)
    expect(db.memorySearch("idempotent")).toHaveLength(1)
  })
})

describe("memory — interface hygiene (ticket: no engine specifics leak)", () => {
  it("public surface exposes only save/search over plain data (no fts/bm25/match in names)", () => {
    const names = Object.keys(db)
    const leaked = names.filter((n) => /fts|bm25|match|trigger|index/i.test(n))
    expect(leaked).toEqual([])
    expect(typeof db.memorySave).toBe("function")
    expect(typeof db.memorySearch).toBe("function")
  })

  it("WAL mode is on (multi-process daemon + server access)", () => {
    expect(db.query1<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal")
  })

  it("entries are plain data: id/text/tags/createdAt, tags default to []", () => {
    const saved = db.memorySave({ text: "plain" }, 500)
    const entry: MemoryEntry = saved
    expect(entry.tags).toEqual([])
    expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "tags", "text"])
  })
})
