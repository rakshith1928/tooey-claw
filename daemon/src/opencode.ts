/**
 * Real ClawOpenCodePort implementation over @opencode-ai/client.
 *
 * This is the ONLY file allowed to know the SDK (SPEC decision 2).
 * Method-name uncertainty in the beta surface is handled here, defensively,
 * so the rest of the daemon sees a stable narrow interface.
 */
import { OpenCode } from "@opencode-ai/client"
import { Service } from "@opencode-ai/client/service"
import { canonical } from "./paths"
import type {
  AgentSummary,
  ClawEvent,
  ClawOpenCodePort,
  CreateSessionInput,
  PluginSummary,
} from "./ports"

export interface ConnectOptions {
  /** Explicit server URL; omit to discover/start the local background service. */
  baseUrl?: string
  /** Bearer token when connecting to an authenticated server. */
  token?: string
}

// The beta wire format wobbles between `T`, `{ data: T }`, and
// `{ items: T[] }`. Both helpers take `unknown` on purpose: this is the
// firewall — callers assert the shape they expect, these normalize it.
function unwrap<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data?: T }).data ?? undefined
  }
  return value as T
}

function toArray<T>(value: unknown): T[] {
  const v = unwrap<T[] | { items?: T[] }>(value)
  if (Array.isArray(v)) return v
  if (v && typeof v === "object" && Array.isArray((v as { items?: T[] }).items)) {
    return (v as { items: T[] }).items
  }
  return []
}

export function isCompatibleVersion(v: string): boolean {
  return v.startsWith("0.") || v.startsWith("2.")
}

export function toLocationDir(p: string): string {
  // Centralized canonicalization for every Location.Ref (symlinks, bind mounts, case).
  try {
    return canonical(p)
  } catch {
    return p
  }
}

export function resolveCandidates(envBin: string | undefined): string[] {
  return envBin ? [envBin] : ["opencode", "opencode2"]
}

export function toWireModel(model: { providerID: string; modelID: string } | undefined) {
  return model ? { providerID: model.providerID, id: model.modelID } : undefined
}

/**
 * The session-control slice of the beta client's session API, duck-typed.
 * Both the external client (client.session) and the in-server plugin
 * context (ctx.session) satisfy this shape — one firewall adapter serves both.
 */
export interface SessionApiLike {
  create(input?: Record<string, unknown>): Promise<unknown>
  switchAgent(input: Record<string, unknown>): Promise<unknown>
  prompt(input: Record<string, unknown>): Promise<unknown>
  wait(input: Record<string, unknown>): Promise<unknown>
  interrupt(input: Record<string, unknown>): Promise<unknown>
  context?(input: Record<string, unknown>): Promise<unknown>
  messages?(input: Record<string, unknown>): Promise<unknown>
}

export type SessionControl = Pick<
  ClawOpenCodePort,
  "createSession" | "prompt" | "wait" | "interrupt" | "transcript"
>

/**
 * Firewall adapter (SPEC decision 2): normalizes the beta session wire shape
 * for BOTH the daemon's HTTP client and the plugin's in-process ctx.session.
 * Beta drift lands here and nowhere else.
 */
export function sessionControl(session: SessionApiLike): SessionControl {
  return {
    async createSession(input: CreateSessionInput) {
      // Wire note (verified against live server): session.create expects
      // model as { providerID, id }; other endpoints/schemas use `modelID`.
      const model = toWireModel(input.model)
      const created = unwrap(
        await session.create({
          location: { directory: toLocationDir(input.directory) },
          ...(input.title ? { title: input.title } : {}),
          ...(model ? { model } : {}),
        }),
      )
      const sessionID = String((created as Record<string, unknown>)?.id ?? "")
      if (!sessionID) throw new Error("session.create returned no id")
      if (input.agent) {
        await session.switchAgent({ sessionID, agent: input.agent })
      }
      return { sessionID }
    },

    async prompt(sessionID, text) {
      await session.prompt({ sessionID, text })
    },

    async wait(sessionID) {
      await session.wait({ sessionID })
    },

    async interrupt(sessionID) {
      await session.interrupt({ sessionID })
    },

    async transcript(sessionID): Promise<string[]> {
      // Prefer the context endpoint (same shape the plugin ctx uses); fall back to message listing.
      const fetchers = [session.context, session.messages].filter(
        (f): f is (input: Record<string, unknown>) => Promise<unknown> => typeof f === "function",
      )
      for (const fetch of fetchers) {
        try {
          const raw = toArray(await fetch.call(session, { sessionID }))
          const lines: string[] = []
          for (const m of raw) {
            const rec = m as Record<string, unknown>
            const parts = rec.parts ?? rec.content
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const p = part as Record<string, unknown>
                if (p.type === "text" && typeof p.text === "string") lines.push(p.text)
              }
            }
          }
          return lines
        } catch {
          /* try next fetcher */
        }
      }
      return []
    },
  }
}

export async function connectOpenCode(options: ConnectOptions = {}): Promise<ClawOpenCodePort> {
  let baseUrl: string
  let headers: Record<string, string>

  if (options.baseUrl) {
    baseUrl = options.baseUrl
    headers = options.token ? { authorization: `Bearer ${options.token}` } : {}
  } else {
    // Discovers a healthy registered service or starts one (opencode serve --service).
    // Try stable binary first, then beta channel; use a real compatibility predicate.
    const envBin = process.env.CLAW_OPENCODE_BIN
    const candidates = resolveCandidates(envBin)
    const isCompatible = isCompatibleVersion
    let lastError: unknown
    let endpoint: Awaited<ReturnType<typeof Service.ensure>> | undefined
    for (const bin of candidates) {
      try {
        endpoint = await Service.ensure({
          command: [bin, "serve", "--service"],
          version: isCompatible,
          onStart(reason, previousVersion) {
            console.log(`[claw] OpenCode service ${reason} (previous: ${previousVersion ?? "none"}) via ${bin}`)
          },
        })
        break
      } catch (e) {
        lastError = e
      }
    }
    if (!endpoint) throw lastError ?? new Error("could not start OpenCode service (tried: " + candidates.join(", ") + ")")
    baseUrl = endpoint.url
    headers = Service.headers(endpoint) as Record<string, string>
  }

  const client = OpenCode.make({ baseUrl, headers })

  return {
    async healthy() {
      try {
        await client.health.get()
        return true
      } catch {
        return false
      }
    },

    async agents(directory?: string): Promise<AgentSummary[]> {
      const input = directory ? { location: { directory: toLocationDir(directory) } } : undefined
      const raw = toArray(await client.agent.list(input))
      return raw.map((a) => {
        const rec = a as Record<string, unknown>
        return {
          id: String(rec.id ?? rec.agentID ?? rec.name ?? ""),
          mode: rec.mode === undefined ? undefined : String(rec.mode),
        }
      })
    },

    async plugins(directory): Promise<PluginSummary[] | undefined> {
      const anyClient = client as unknown as {
        plugin?: { list?: (input?: unknown) => Promise<unknown> }
      }
      const fn = anyClient.plugin?.list
      if (typeof fn !== "function") return undefined // endpoint absent in this beta
      try {
        const raw = toArray(await fn.call(anyClient.plugin, { location: { directory: toLocationDir(directory) } }))
        return raw.map((p) => {
          const rec = p as Record<string, unknown>
          return {
            id: rec.id === undefined ? undefined : String(rec.id),
            name: rec.name === undefined ? undefined : String(rec.name),
          }
        })
      } catch {
        return undefined // treat any beta-shape mismatch as "unknown", not "failed"
      }
    },

    // Session control goes through the same firewall adapter the plugin uses.
    ...sessionControl(client.session as unknown as SessionApiLike),

    // Normalize the beta wire shape ({ type, data: { sessionID }, ... }) to
    // ClawEvent at the firewall; consumers never touch raw fields. Beta drift
    // lands here, in this one mapping function, nowhere else (decision 2).
    async *events(): AsyncIterable<ClawEvent> {
      for await (const raw of client.event.subscribe() as AsyncIterable<Record<string, unknown>>) {
        const data = (raw?.data ?? {}) as Record<string, unknown>
        yield {
          type: String(raw?.type ?? ""),
          sessionID: typeof data.sessionID === "string" ? data.sessionID : undefined,
          data,
        }
      }
    },
  }
}
