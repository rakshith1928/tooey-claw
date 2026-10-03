/**
 * Memory tools + injection assembly (ticket 08).
 *
 * Same split as taskops (ticket 04): `memorySaveOp` / `memorySearchOp` are
 * the entire logic behind the plugin's `memory_save` / `memory_search`
 * tools, proven here with a real DB and no server. `assembleInjection`
 * builds the auto-injected context block (relevant memories + open tasks)
 * the scheduler prepends to dispatched prompts; it is pure over ClawDb, so
 * its exact shape is snapshot-pinned in tests.
 */
import type { ClawDb, MemoryEntry } from "./db"
import type { Clock } from "./ports"

/** Memories injected per dispatch (top-k keyword matches). */
export const MEMORY_TOP_K = 3
/** Open tasks injected per dispatch. */
export const OPEN_TASK_LIMIT = 10

export function memorySaveOp(db: ClawDb, clock: Clock, input: { text: string; tags?: string[] }): MemoryEntry {
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new Error("memory_save: 'text' must be a non-empty string")
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new Error("memory_save: 'tags' must be an array of strings")
  }
  return db.memorySave({ text: input.text, tags: input.tags }, clock.now())
}

export function memorySearchOp(
  db: ClawDb,
  input: { query: string; tags?: string[]; limit?: number },
): MemoryEntry[] {
  if (typeof input.query !== "string") {
    throw new Error("memory_search: 'query' must be a string")
  }
  return db.memorySearch(input.query, { tags: input.tags, limit: input.limit })
}

/** Compact JSON-safe projection for tool output (no sqlite internals). */
export function memorySummary(e: MemoryEntry): Record<string, unknown> {
  return { id: e.id, text: e.text, tags: e.tags, createdAt: e.createdAt }
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * Build the auto-injected context block for a dispatch prompt, keyed off the
 * schedule's own prompt text: top-k memories by keyword match, then the
 * currently open (queued + running) tasks oldest-first. Sections with no
 * content are omitted; fully empty state yields "" so prompts stay untouched.
 */
export function assembleInjection(
  db: ClawDb,
  opts: { query: string; memoryLimit?: number; taskLimit?: number },
): string {
  const memoryLimit = opts.memoryLimit ?? MEMORY_TOP_K
  const taskLimit = opts.taskLimit ?? OPEN_TASK_LIMIT
  const sections: string[] = []

  if (opts.query.trim().length > 0) {
    const memories = db.memorySearch(opts.query, { limit: memoryLimit })
    if (memories.length > 0) {
      sections.push(
        [
          `--- RELEVANT MEMORIES (auto-injected, top ${memoryLimit} by keyword match) ---`,
          ...memories.map((m) => `- ${m.text}${m.tags.length > 0 ? ` [tags: ${m.tags.join(", ")}]` : ""}`),
          "--- END MEMORIES ---",
        ].join("\n"),
      )
    }
  }

  const open = [
    ...db.listTasks({ status: "queued", limit: taskLimit }),
    ...db.listTasks({ status: "running", limit: taskLimit }),
  ]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, taskLimit)
  if (open.length > 0) {
    sections.push(
      [
        "--- OPEN TASKS (auto-injected) ---",
        ...open.map((t) => `- ${shortId(t.id)} ${t.type} (${t.status})`),
        "--- END OPEN TASKS ---",
      ].join("\n"),
    )
  }

  return sections.join("\n\n")
}
