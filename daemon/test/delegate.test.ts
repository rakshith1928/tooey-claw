import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openClawDb, type ClawDb } from "../src/db"
import { runDelegation, type DelegateDeps } from "../src/delegate"
import { FakeClock, closeDb, flush, makeFakePort } from "./helpers"

const SEC = 1000
const TIMEOUT = 300 * SEC

let tmp: string
let db: ClawDb
let clock: FakeClock
let fake: ReturnType<typeof makeFakePort>
let deps: DelegateDeps

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "claw-deleg-"))
  db = openClawDb(path.join(tmp, "claw.db"))
  clock = new FakeClock()
  fake = makeFakePort()
  deps = {
    port: fake.port,
    db,
    clock,
    clawRoot: "C:\\claw",
    timeoutMs: TIMEOUT,
    model: { providerID: "openrouter", modelID: "openrouter/free" },
    log: () => {},
  }
})
afterEach(() => {
  closeDb(db)
  rmSync(tmp, { recursive: true, force: true })
})

const orchestratorCall = {
  parentSessionID: "ses_parent",
  parentAgent: "claw",
  agent: "worker",
  task: "Inspect repo X and report failing CI jobs.",
}

describe("delegation — happy path (ticket: orchestrator → worker)", () => {
  it("creates a worker-targeted claw-root session carrying the sub-task text", async () => {
    fake.setTranscript(["WORKER RESULT: 2 failing jobs: lint, e2e"])
    const out = await runDelegation(deps, orchestratorCall)

    expect(out.ok).toBe(true)
    // Ticket checkbox 1: worker-targeted session + sub-task prompt, asserted on the fake client.
    expect(fake.sessions).toHaveLength(1)
    expect(fake.sessions[0]).toMatchObject({ directory: "C:\\claw", agent: "worker" })
    expect(fake.prompts).toEqual([{ sessionID: "ses_1", text: orchestratorCall.task }])
    // Ticket checkbox 2: worker result returned into the orchestrator's context (tool output).
    expect(out.output).toContain("WORKER RESULT: 2 failing jobs")
  })

  it("tracks the delegation as a durable task row (visible to watchdog + task tools)", async () => {
    fake.setTranscript(["done inspecting"])
    const out = await runDelegation(deps, orchestratorCall)

    const task = db.getTask(out.taskId!)!
    expect(task.status).toBe("done")
    expect(task.type).toBe("delegate")
    expect(task.payload).toMatchObject({ parentSessionID: "ses_parent", agent: "worker" })
    expect((task.result as Record<string, unknown>).sessionID).toBe("ses_1")
    expect(fake.waited).toEqual(["ses_1"]) // awaited, not fire-and-forget
  })

  it("pins the configured model on the worker session", async () => {
    await runDelegation(deps, orchestratorCall)
    expect(fake.sessions[0]!.model).toEqual({ providerID: "openrouter", modelID: "openrouter/free" })
  })
})

describe("delegation — depth cap (ticket: worker may not delegate)", () => {
  it("refuses a delegate call made from a delegated (worker) session, side-effect-free", async () => {
    const out = await runDelegation(deps, { ...orchestratorCall, parentAgent: "worker" })

    expect(out.ok).toBe(false)
    expect(out.output).toMatch(/refus|depth/i)
    expect(fake.sessions).toHaveLength(0) // refused BEFORE any side effect
    expect(db.listRunning()).toHaveLength(0)
    expect(db.queryAll("SELECT * FROM tasks")).toHaveLength(0)
  })
})

describe("delegation — timeout (ticket: overruns fail cleanly, task marked failed)", () => {
  it("interrupts the worker and fails the task when wait overruns", async () => {
    fake.setTranscript(["partial"])
    const gate = fake.armWaitGate() // worker never settles
    try {
      const p = runDelegation(deps, orchestratorCall)
      await flush() // let createSession + prompt run
      clock.advance(TIMEOUT + 1)
      const out = await p

      expect(out.ok).toBe(false)
      expect(out.output).toMatch(/timed out/i)
      expect(fake.interrupted).toEqual(["ses_1"]) // worker interrupted, not left running
      const task = db.getTask(out.taskId!)!
      expect(task.status).toBe("failed")
      expect(task.error).toMatch(/timed out/i)
      expect((task.result as Record<string, unknown>).sessionID).toBe("ses_1") // pointer preserved
    } finally {
      gate.open() // release the fake so nothing hangs
    }
  })

  it("settles BEFORE the timeout still succeeds (timer doesn't misfire)", async () => {
    fake.setTranscript(["finished fast"])
    const gate = fake.armWaitGate()
    const p = runDelegation(deps, orchestratorCall)
    await flush()
    gate.open()
    const out = await p
    expect(out.ok).toBe(true)
    clock.advance(TIMEOUT + 1) // late timer advance must not matter
    expect(fake.interrupted).toHaveLength(0)
    expect(fake.port && db.getTask(out.taskId!)!.status).toBe("done")
  })

  it("a session-creation failure fails the task cleanly, no ghost sessions", async () => {
    const broken = {
      ...deps,
      port: {
        ...fake.port,
        createSession: async () => {
          throw new Error("server said no")
        },
      },
    }
    const out = await runDelegation(broken, orchestratorCall)
    expect(out.ok).toBe(false)
    expect(out.output).toMatch(/server said no/)
    const task = db.getTask(out.taskId!)!
    expect(task.status).toBe("failed")
    expect(task.error).toContain("server said no")
  })
})
