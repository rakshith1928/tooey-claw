/**
 * Real ClawOpenCodePort implementation over @opencode-ai/client.
 *
 * This is the ONLY file allowed to know the SDK (SPEC decision 2).
 * Method-name uncertainty in the beta surface is handled here, defensively,
 * so the rest of the daemon sees a stable narrow interface.
 */
import { OpenCode } from "@opencode-ai/client"
import { Service } from "@opencode-ai/client/service"
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

function unwrap<T>(value: T | { data?: T } | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data?: T }).data ?? undefined
  }
  return value
}

function toArray<T>(value: T[] | { items?: T[] } | undefined): T[] {
  const v = unwrap(value)
  if (Array.isArray(v)) return v
  if (v && typeof v === "object" && Array.isArray((v as { items?: T[] }).items)) {
    return (v as { items: T[] }).items
  }
  return []
}

export async function connectOpenCode(options: ConnectOptions = {}): Promise<ClawOpenCodePort> {
  let baseUrl: string
  let headers: Record<string, string>

  if (options.baseUrl) {
    baseUrl = options.baseUrl
    headers = options.token ? { authorization: `Bearer ${options.token}` } : {}
  } else {
    // Discovers a healthy registered service or starts one (opencode serve --service).
    // Command and version-predicate are overridden because this machine ships the
    // CLI as `opencode2` with a beta version string; defaults would misfire.
    const bin = process.env.CLAW_OPENCODE_BIN ?? "opencode2"
    const endpoint = await Service.ensure({
      command: [bin, "serve", "--service"],
      version: () => true,
    })
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
      const input = directory ? { location: { directory } } : undefined
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
        const raw = toArray(await fn.call(anyClient.plugin, { location: { directory } }))
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

    async createSession(input: CreateSessionInput) {
      // Wire note (verified against live server): session.create expects
      // model as { providerID, id }; other endpoints/schemas use `modelID`.
      const model = input.model
        ? { providerID: input.model.providerID, id: input.model.modelID }
        : undefined
      const created = unwrap(
        await client.session.create({
          location: { directory: input.directory },
          ...(input.title ? { title: input.title } : {}),
          ...(model ? { model } : {}),
        }),
      )
      const sessionID = String((created as Record<string, unknown>)?.id ?? "")
      if (!sessionID) throw new Error("session.create returned no id")
      if (input.agent) {
        await client.session.switchAgent({ sessionID, agent: input.agent })
      }
      return { sessionID }
    },

    async prompt(sessionID, text) {
      await client.session.prompt({ sessionID, text })
    },

    async wait(sessionID) {
      await client.session.wait({ sessionID })
    },

    async interrupt(sessionID) {
      await client.session.interrupt({ sessionID })
    },

    async transcript(sessionID): Promise<string[]> {
      // Prefer the context endpoint (same shape the plugin ctx uses); fall back to message listing.
      const anyClient = client.session as unknown as Record<
        string,
        ((input: unknown) => Promise<unknown>) | undefined
      >
      const fetchers = [anyClient.context, anyClient.messages].filter(
        (f): f is (input: unknown) => Promise<unknown> => typeof f === "function",
      )
      for (const fetch of fetchers) {
        try {
          const raw = toArray(await fetch.call(client.session, { sessionID }))
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

    // NOTE: the documented zero-argument subscribe form is used because the
    // beta request-options shape for streaming endpoints is not contractual.
    // Cancellation refinement lands with ticket 03 (event-driven completion).
    events(): AsyncIterable<ClawEvent> {
      return client.event.subscribe()
    },
  }
}
