/**
 * Claw daemon entry point.
 *
 * Modes:
 *   bun run dev            → normal run (scheduler lands in ticket 02)
 *   bun run check          → free infrastructure checks, no session/model calls
 *   CLAW_PROBE=1 bun run dev → live probe: real session, real plugin tool call
 */
import { connectOpenCode } from "./opencode"
import { canonical, CLAW_ROOT, ensureDataDir } from "./paths"
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
  const agentsInClaw = await port.agents(CLAW_DIR)
  const ids = new Set(agentsInClaw.map((a) => a.id))
  for (const required of ["claw", "worker"]) {
    if (!ids.has(required)) {
      const hint =
        `agent '${required}' not visible in the Claw location (${CLAW_DIR}). ` +
        `If this is a fresh clone or you just added .opencode/ content, run: ` +
        `opencode service restart (or opencode2 service restart on beta) and retry.`
      fail(hint)
    }
  }
  console.log(
    `✓ agents visible in Claw location: ${agentsInClaw.map((a) => a.id).sort().join(", ")}`,
  )

  // Isolation: query an outside directory (canonicalized) — never string-compare raw paths.
  const outsideDirRaw = canonical(process.cwd()) === canonical(CLAW_DIR) ? path.dirname(CLAW_DIR) : process.cwd()
  const outside = await port.agents(outsideDirRaw)
  const clawLeak = outside.filter((a) => a.id === "claw" || a.id === "worker")
  if (clawLeak.length > 0) {
    console.warn(
      `[claw] isolation warning: claw/worker visible at ${outsideDirRaw} (canonical ${canonical(outsideDirRaw)}) — expected only inside ${CLAW_DIR}`,
    )
  } else {
    console.log(`✓ isolation: no claw agents visible at ${outsideDirRaw}`)
  }

  // ── Plugin registration (free) + optional live probe (costs a model call) ─
  const plugins = await port.plugins(CLAW_DIR)
  if (plugins === undefined) {
    console.warn("[claw] plugin listing unavailable in this client/server build — skipping")
  } else {
    const names = plugins.map((p) => p.id ?? p.name ?? "?").join(", ")
    if (!names.includes("claw-core")) {
      fail("claw-core plugin not registered for the Claw location")
    }
    console.log(`✓ plugins loaded for Claw location: ${names}`)
  }

  if (checkOnly) return

  if (!probe) {
    console.log("✓ boot checks complete (scheduler arrives with ticket 02)")
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
