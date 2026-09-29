/**
 * Project-local scheduler config (ticket 02): `claw.json` at the Claw root
 * declares watched repositories and cadences. Pure parsing — I/O lives in
 * loadConfig so every rule is unit-testable.
 */
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { canonical } from "./paths"
import type { ModelRef } from "./ports"

export interface RawSchedule {
  id?: unknown
  name?: unknown
  repo?: unknown
  cadence?: unknown
  prompt?: unknown
  enabled?: unknown
}

export interface ScheduleConfig {
  id: string
  name: string
  /** Absolute watched repository directory (SPEC decision 11). */
  repo: string
  /** Raw spec string, e.g. "every:15m" — stored on the schedule row. */
  cadence: string
  cadenceMs: number
  prompt: string
  enabled: boolean
}

export type PermissionEffect = "allow" | "deny" | "ask"

/** Permission policy (ticket 06): deny-by-default with an explicit allowance list. */
export interface Policy {
  /** Destructive actions opted in (may run without asking a human). */
  allow: string[]
}

export interface ClawConfig {
  tickMs: number
  /** Watchdog budget per run: running tasks with no terminal event past this are force-failed. */
  taskTimeoutMs: number
  /** Per-delegation budget: a delegate call that overruns is interrupted and failed. */
  delegateTimeoutMs: number
  /** Model pinned for every scheduled dispatch (unattended runs never use server defaults). */
  model?: ModelRef
  /** Centralized permission policy; defaults to the strictest (empty allow list). */
  policy: Policy
  schedules: ScheduleConfig[]
}

/** "provider/model" (model may contain slashes) → ModelRef. */
export function parseModelRef(raw: unknown): ModelRef | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") throw new Error("config model must be a string \"provider/model\"")
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`config model ${JSON.stringify(raw)} must look like "provider/model"`)
  }
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

/** Parse the optional `policy` block: `{ allow: ["shell"] }` → { allow: ["shell"] }. */
export function parsePolicy(raw: unknown): Policy {
  if (raw === undefined || raw === null) return { allow: [] } // strictest default
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config policy must be an object like { "allow": ["shell"] }`)
  }
  const allow = (raw as { allow?: unknown }).allow
  if (allow === undefined) return { allow: [] }
  if (!Array.isArray(allow) || allow.some((a) => typeof a !== "string")) {
    throw new Error(`config policy.allow must be an array of strings, got ${JSON.stringify(allow)}`)
  }
  // Drop blanks: an empty/whitespace entry must not become a wildcard.
  return { allow: allow.map((a) => a.trim()).filter((a) => a.length > 0) }
}

/** "every:15m" / "every:2h" / "every:1d" → milliseconds. */
export function parseCadence(spec: unknown): number {
  const m = typeof spec === "string" ? /^every:(\d+)([mhd])$/.exec(spec) : null
  if (!m) throw new Error(`invalid cadence ${JSON.stringify(spec)} — expected "every:<n>[mhd]" like "every:15m"`)
  const n = Number(m[1])
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]!
  return n * unit
}

function reqString(obj: RawSchedule, key: keyof RawSchedule): string {
  const v = obj[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`schedule ${JSON.stringify(obj.id ?? "?")}: required field '${String(key)}' missing or not a string`)
  }
  return v
}

export function parseConfig(raw: unknown): ClawConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("claw config must be a JSON object with a 'schedules' array")
  }
  const obj = raw as {
    tickSeconds?: unknown
    taskTimeoutSeconds?: unknown
    delegateTimeoutSeconds?: unknown
    model?: unknown
    policy?: unknown
    schedules?: unknown
  }
  if (!Array.isArray(obj.schedules)) {
    throw new Error("claw config must have a 'schedules' array")
  }
  const tickMs = obj.tickSeconds === undefined ? 60_000 : Number(obj.tickSeconds) * 1000
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    throw new Error(`config tickSeconds must be a positive number, got ${JSON.stringify(obj.tickSeconds)}`)
  }
  const taskTimeoutMs = obj.taskTimeoutSeconds === undefined ? 900_000 : Number(obj.taskTimeoutSeconds) * 1000
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) {
    throw new Error(
      `config taskTimeoutSeconds must be a positive number, got ${JSON.stringify(obj.taskTimeoutSeconds)}`,
    )
  }
  const delegateTimeoutMs =
    obj.delegateTimeoutSeconds === undefined ? 600_000 : Number(obj.delegateTimeoutSeconds) * 1000
  if (!Number.isFinite(delegateTimeoutMs) || delegateTimeoutMs <= 0) {
    throw new Error(
      `config delegateTimeoutSeconds must be a positive number, got ${JSON.stringify(obj.delegateTimeoutSeconds)}`,
    )
  }

  const seen = new Set<string>()
  const schedules = obj.schedules.map((entry) => {
    const s = (typeof entry === "object" && entry !== null ? entry : {}) as RawSchedule
    const id = reqString(s, "id")
    if (seen.has(id)) throw new Error(`duplicate schedule id '${id}'`)
    seen.add(id)
    const cadenceMs = parseCadence(s.cadence) // throws before we trust the raw string
    return {
      id,
      name: typeof s.name === "string" && s.name ? s.name : id,
      repo: reqString(s, "repo"),
      cadence: s.cadence as string,
      cadenceMs,
      prompt: reqString(s, "prompt"),
      enabled: s.enabled === undefined ? true : s.enabled === true,
    } satisfies ScheduleConfig
  })
  const model = parseModelRef(obj.model)
  const policy = parsePolicy(obj.policy)
  return { tickMs, taskTimeoutMs, delegateTimeoutMs, policy, ...(model ? { model } : {}), schedules }
}

export function defaultConfigPath(root: string): string {
  return path.join(root, "claw.json")
}

export function loadConfig(root: string): ClawConfig {
  const file = defaultConfigPath(root)
  if (!existsSync(file)) {
    throw new Error(`no claw config at ${file} — copy claw.example.json to claw.json and edit it`)
  }
  const cfg = parseConfig(JSON.parse(readFileSync(file, "utf8")))
  // Watched repos are location refs; canonicalize once at load (ticket 01 lesson).
  return { ...cfg, schedules: cfg.schedules.map((s) => ({ ...s, repo: canonical(s.repo) })) }
}
