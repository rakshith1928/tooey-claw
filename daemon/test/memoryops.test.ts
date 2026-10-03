import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import {
  MEMORY_TOP_K,
  OPEN_TASK_LIMIT,
  assembleInjection,
  memorySaveOp,
  memorySearchOp,
  memorySummary,
} from "../src/memoryops"
import { FakeClock, closeDb } from "./helpers"

/**
 * Ticket 08: memory tools + injection assembly. The plugin's memory_save /
 * memory_search tools are thin JSON adapters over these functions (same
 * split as taskops in ticket 04), so the round-trip is proven here with a
 * real temp DB and a fake clock — no server.
 */

let tmp: string
let db: ClawDb
let clock: FakeClock

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-memops-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
})
afterEach(() => {
  closeDb(db)
  rmSync(tmp, { recursive: true, force: true })
})

describe("memory tools — round-trip (ticket checkbox 1)", () => {
  it("save then search returns the entry (agent-session round-trip shape)", () => {
    const saved = memorySaveOp(db, clock, { text: "VERDICT: 2 open issues", tags: ["watchdog", "demo"] })
    expect(saved.id).toBeTruthy()

    const hits = memorySearchOp(db, { query: "open issues" })
    expect(hits.map((h) => h.id)).toEqual([saved.id])
    expect(memorySummary(hits[0]!)).toEqual({
      id: saved.id,
      text: "VERDICT: 2 open issues",
      tags: ["watchdog", "demo"],
      createdAt: clock.now(),
    })
  })

  it("rejects empty text and non-string tags instead of storing junk", () => {
    expect(() => memorySaveOp(db, clock, { text: "   " })).toThrow(/non-empty/i)
    expect(() => memorySaveOp(db, clock, { text: "ok", tags: "nope" as unknown as string[] })).toThrow(/tags/)
  })

  it("search honors tags + limit (tool-input shape)", () => {
    memorySaveOp(db, clock, { text: "postgres tuning", tags: ["runbook"] })
    memorySaveOp(db, clock, { text: "postgres incident", tags: ["incident"] })
    expect(memorySearchOp(db, { query: "postgres", tags: ["incident"] }).map((h) => h.text)).toEqual([
      "postgres incident",
    ])
    expect(memorySearchOp(db, { query: "postgres", limit: 1 })).toHaveLength(1)
  })
})

describe("injection assembly — snapshot (ticket checkbox 2)", () => {
  it("memories block + open-tasks block, exact shape pinned", () => {
    clock.time = 5000
    db.memorySave({ text: "VERDICT: 2 open issues, next: since abc123", tags: ["watchdog"] }, 1000)
    const t = db.createTask({ type: "follow-up", payload: { note: "recheck flaky" } }, 2000)

    expect(assembleInjection(db, { query: "open issues" })).toBe(
      [
        "--- RELEVANT MEMORIES (auto-injected, top 3 by keyword match) ---",
        "- VERDICT: 2 open issues, next: since abc123 [tags: watchdog]",
        "--- END MEMORIES ---",
        "",
        "--- OPEN TASKS (auto-injected) ---",
        `- ${t.id.slice(0, 8)} follow-up (queued)`,
        "--- END OPEN TASKS ---",
      ].join("\n"),
    )
  })

  it("omits empty sections; fully empty state injects nothing", () => {
    db.memorySave({ text: "unrelated lunch notes", tags: [] }, 1000)
    // No memories match "postgres", no tasks exist → empty string, prompt untouched.
    expect(assembleInjection(db, { query: "postgres" })).toBe("")

    db.createTask({ type: "follow-up", payload: {} }, 2000)
    const only = assembleInjection(db, { query: "postgres" })
    expect(only).not.toContain("MEMORIES")
    expect(only).toContain("OPEN TASKS")
  })

  it("caps memories at top-k and tasks at the open-task limit", () => {
    expect(MEMORY_TOP_K).toBe(3)
    expect(OPEN_TASK_LIMIT).toBe(10)
    for (let i = 0; i < 5; i++) {
      clock.advance(1)
      memorySaveOp(db, clock, { text: `postgres note ${i}`, tags: [] })
    }
    const block = assembleInjection(db, { query: "postgres" })
    expect(block.split("\n").filter((l) => l.startsWith("- postgres")).length).toBe(3)
  })
})
