/**
 * Claw daemon entry point.
 *
 * Modes:
 *   bun run dev            → run mode: boot checks, then the scheduler loop (ticket 02)
 *   bun run check          → free infrastructure checks, no session/model calls
 *   CLAW_PROBE=1 bun run dev → live probe: real session, real plugin tool call
 */
import { connectOpenCode } from "./opencode"
import { findClawAgentLeak, findMissingAgents, hasPlugin } from "./checks"
import { loadConfig } from "./config"
import { openClawDb } from "./db"
import { canonical, DB_PATH, KILL_SWITCH_PATH, CLAW_ROOT, ensureDataDir } from "./paths"
import { SystemClock } from "./clock"
import { createScheduler } from "./scheduler"
import type { ClawOpenCodePort } from "./ports"
import { existsSync } from "node:fs"
import path from "node:path"

const CLAW_DIR = CLAW_ROOT

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  try {
    return JSON.stringify(error, null, 2) ?? String(error)
  } catch {
    return String(error)
  }
}

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * Run mode (ticket 02): the scheduler loop over the project-local config.
 * Ctrl-C (or SIGTERM) stops the loop cleanly; the DB claim/lock discipline
 * means a hard kill is also recoverable (duplicates are prevented by
 * last_dispatched_at, verified in scheduler tests).
 */
async function runSchedulerLoop(port: ClawOpenCodePort): Promise<void> {
  const config = loadConfig(CLAW_DIR)
  const db = openClawDb(DB_PATH)
  const scheduler = createScheduler({
    clock: SystemClock,
    port,
    db,
    config,
    clawRoot: CLAW_DIR,
    killSwitchPath: KILL_SWITCH_PATH,
  })

  const shutdown = () => {
    console.log("[claw] stopping scheduler…")
    scheduler.stop()
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  console.log(
    `[claw] scheduler running: ${config.schedules.length} schedule(s), ` +
      `tick ${Math.round(config.tickMs / 1000)}s, db ${DB_PATH}`,
  )
  console.log(`[claw] kill switch: create ${KILL_SWITCH_PATH} to halt dispatch (Ctrl-C stops the daemon)`)
  await scheduler.runLoop()
  db.close()
  console.log("[claw] scheduler stopped")
}

async function main() {
  const checkOnly = process.argv.includes("--check")
  const probe = process.env.CLAW_PROBE === "1"
  ensureDataDir()

  console.log(`[claw] root: ${CLAW_DIR}`)

  // ── Free checks: no sessions, no model calls ──────────────────────────────
  if (!existsSync(path.join(CLAW_DIR, ".opencode")) || !existsSync(path.join(CLAW_DIR, "opencode.json"))) {
    console.warn(`[claw] warning: ${CLAW_DIR} lacks .opencode/ or opencode.json — is CLAW_ROOT correct?`)
  }

  const port = await connectOpenCode()
  const healthy = await port.healthy()

  if (!healthy) {
    fail(
      "OpenCode service is not reachable. Try `opencode2 service status` / `opencode2 service restart`.",
    )
  }
  console.log("✓ OpenCode service healthy")

  // ── Agent visibility + isolation ─────────────────────────────────────────
  // Acceptance (ticket 01): claw+worker visible inside the root; a location
  // outside the root sees neither Claw agents nor the claw-core plugin.
  // Leaks are hard failures: isolation is an acceptance criterion, not advice.
  const requiredAgents = ["claw", "worker"] as const
  const agentsInClaw = await port.agents(CLAW_DIR)
  const missing = findMissingAgents(requiredAgents, agentsInClaw)
  if (missing.length > 0) {
    fail(
      `agent(s) [${missing.join(", ")}] not visible in the Claw location (${CLAW_DIR}). ` +
        `If this is a fresh clone or you just added .opencode/ content, run: ` +
        `opencode service restart (or opencode2 service restart on beta) and retry.`,
    )
  }
  console.log(
    `✓ agents visible in Claw location: ${agentsInClaw.map((a) => a.id).sort().join(", ")}`,
  )

  // Isolation: query a directory definitely outside the Claw project (parent dir).
  // Using cwd is fragile when cwd itself is another Claw checkout (e.g., CLAW_ROOT override).
  const outsideDirRaw = path.dirname(CLAW_DIR)
  const outsideAgents = await port.agents(outsideDirRaw)
  const agentLeak = findClawAgentLeak(outsideAgents)
  if (agentLeak.length > 0) {
    fail(
      `isolation violated: agent(s) [${agentLeak.map((a) => a.id).join(", ")}] visible at ` +
        `${outsideDirRaw} (canonical ${canonical(outsideDirRaw)}) — expected only inside ${CLAW_DIR}`,
    )
  }
  const outsidePlugins = await port.plugins(outsideDirRaw)
  if (outsidePlugins === undefined) {
    console.warn("[claw] plugin listing unavailable outside root — skipping plugin isolation check")
  } else if (hasPlugin(outsidePlugins, "claw-core")) {
    fail(
      `isolation violated: claw-core plugin loaded at ${outsideDirRaw} ` +
        `(canonical ${canonical(outsideDirRaw)}) — expected only inside ${CLAW_DIR}`,
    )
  }
  console.log(`✓ isolation: no claw agents or claw-core plugin at ${outsideDirRaw} (parent of ${CLAW_DIR})`)

  // ── Plugin registration (free) + optional live probe (costs a model call) ─
  const plugins = await port.plugins(CLAW_DIR)
  if (plugins === undefined) {
    console.warn("[claw] plugin listing unavailable in this client/server build — skipping")
  } else {
    if (!hasPlugin(plugins, "claw-core")) {
      fail("claw-core plugin not registered for the Claw location")
    }
    const names = plugins.map((p) => p.id ?? p.name ?? "?").join(", ")
    console.log(`✓ plugins loaded for Claw location: ${names}`)
  }

  if (checkOnly) return

  if (!probe) {
    await runSchedulerLoop(port)
    return
  }

  // ── Live probe: proves tools actually execute end-to-end ─────────────────
  // Optional CLAW_PROBE_MODEL="provider/model" pins the model so probes are
  // cheap and deterministic instead of inheriting server-side defaults.
  const modelRef = (() => {
    const raw = process.env.CLAW_PROBE_MODEL
    if (!raw) return undefined
    const slash = raw.indexOf("/")
    if (slash <= 0) throw new Error('CLAW_PROBE_MODEL must look like "provider/model"')
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
  })()

  console.log("[claw] probe: creating session and invoking claw_probe…")
  const { sessionID } = await port.createSession({
    directory: CLAW_DIR,
    agent: "claw",
    title: "claw-core probe",
    ...(modelRef ? { model: modelRef } : {}),
  })
  console.log(`[claw] probe session: ${sessionID}${modelRef ? ` (model ${modelRef.providerID}/${modelRef.modelID})` : ""}`)
  await port.prompt(sessionID, "Call the claw_probe tool and reply with exactly its output.")
  await port.wait(sessionID)

  const lines = await port.transcript(sessionID)
  const hit = lines.find((l) => l.includes("claw-core OK"))
  if (!hit) {
    console.error("✗ probe failed: expected tool output not found in transcript")
    console.error(lines.slice(-20).join("\n---\n"))
    process.exit(1)
  }
  console.log(`✓ probe: ${hit.trim().slice(0, 120)}`)
  console.log("\nTicket 01 acceptance: all green.")
}

main().catch((error) => {
  fail(describe(error))
})
