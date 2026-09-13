import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import { parseConfig } from "../src/config"
import { createScheduler } from "../src/scheduler"
import { watchEvents } from "../src/completion"
import { FakeClock, flush, makeFakePort } from "./helpers"

/**
 * Ticket 05 — the full two-run chain at the daemon-loop seam:
 * schedule → orchestrator session → completion (event watcher) → pointer
 * persisted → run 2 dispatch is INCREMENTAL (pointer in payload + prompt)
 * → completion → both verdicts inspectable in the DB.
 */
const MIN = 60_000

let tmp: string
let db: ClawDb
let clock: FakeClock
let fake: ReturnType<typeof makeFakePort>

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-e2e-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
  fake = makeFakePort()
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

it("ticket: two consecutive unattended runs — run 2 is incremental, both verdicts in DB", async () => {
  const config = parseConfig({
    tickSeconds: 60,
    model: "openrouter/openrouter/free",
    schedules: [
      {
        id: "demo",
        name: "Demo repo",
        repo: "C:\\repos\\demo",
        cadence: "every:15m",
        prompt: "Watchdog run for this repository. Report repo activity.",
      },
    ],
  })
  const scheduler = createScheduler({
    clock,
    port: fake.port,
    db,
    config,
    clawRoot: "C:\\claw",
    killSwitchPath: path.join(tmp, "kill"),
    log: () => {},
  })

  // The completion watcher runs concurrently, as in the real daemon.
  const watcher = watchEvents({ db, clock, port: fake.port, log: () => {} })

  // ── Run 1 ──────────────────────────────────────────────────────────────
  const r1 = await scheduler.tick()
  expect(r1.dispatched).toHaveLength(1)
  expect(fake.prompts[0]!.text).not.toContain("PREVIOUS RUN") // first run: no history

  // Worker "finishes": the terminal event arrives over the stream.
  fake.setTranscript(["VERDICT: 2 open issues, 1 CI failure. Next-run: since commit abc123."])
  fake.emit({ type: "session.execution.succeeded", sessionID: "ses_1" })
  await flush()

  const run1 = db.getTask(r1.dispatched[0]!.taskId)!
  expect(run1.status).toBe("done")
  const result1 = run1.result as { verdict: string; pointer: { lastFinishedAt: number } }
  expect(result1.verdict).toContain("2 open issues")
  expect(result1.pointer.lastFinishedAt).toBe(clock.now()) // real completion timestamp

  // ── Run 2 (cadence elapsed; run 1 finished, so the in-flight guard lets it pass) ──
  clock.advance(15 * MIN)
  const r2 = await scheduler.tick()
  expect(r2.dispatched).toHaveLength(1)
  expect(r2.inFlight).toEqual([])

  // Checkbox: run 2's dispatch payload demonstrably contains run 1's pointer.
  const run2Row = db.getTask(r2.dispatched[0]!.taskId)!
  const payload2 = run2Row.payload as { previous: { pointer: unknown } }
  expect(payload2.previous.pointer).toEqual(result1.pointer)

  // …and the PROMPT is incremental: verdict + pointer inlined.
  const prompt2 = fake.prompts[1]!.text
  expect(prompt2).toContain("PREVIOUS RUN")
  expect(prompt2).toContain("VERDICT: 2 open issues")
  expect(prompt2).toContain(JSON.stringify(result1.pointer))

  // Run 2 completes too; both verdicts inspectable in the DB.
  fake.setTranscript(["VERDICT: since abc123 — 1 new issue. Next-run: since commit def456."])
  fake.emit({ type: "session.execution.succeeded", sessionID: "ses_2" })
  await flush()
  expect(db.getTask(r2.dispatched[0]!.taskId)!.status).toBe("done")

  const done = db.listTasks({ type: "watchdog", status: "done" })
  expect(done).toHaveLength(2)
  expect(done.map((t) => (t.result as { verdict: string }).verdict).join(" | ")).toContain("since abc123")

  fake.closeEvents()
  await watcher
})
