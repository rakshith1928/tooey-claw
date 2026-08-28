/**
 * Task visibility tools (ticket 04): `task_create` / `task_list` /
 * `task_update` for agents, as plain functions over ClawDb so the
 * create/list/update round-trip is proven without a server. The plugin's
 * tools are thin JSON adapters over these.
 */
import type { ClawDb, Task } from "./db"
import type { Clock } from "./ports"

export function taskCreate(db: ClawDb, clock: Clock, input: { type: string; payload?: unknown }): Task {
  if (typeof input.type !== "string" || input.type.trim().length === 0) {
    throw new Error("task_create: 'type' must be a non-empty string")
  }
  return db.createTask({ type: input.type, payload: input.payload ?? {} }, clock.now())
}

export function taskList(db: ClawDb, opts: { status?: string; type?: string; limit?: number } = {}): Task[] {
  return db.listTasks(opts)
}

/** running → markTaskRunning; done/failed → finishTask. Throws on unknown id. */
export function taskUpdate(
  db: ClawDb,
  clock: Clock,
  input: { id: string; status: "running" | "done" | "failed"; error?: string; result?: unknown },
): Task {
  const existing = db.getTask(input.id)
  if (!existing) throw new Error(`task_update: task '${input.id}' not found`)
  if (input.status !== "running" && input.status !== "done" && input.status !== "failed") {
    throw new Error(`task_update: invalid status ${JSON.stringify(input.status)} (running|done|failed)`)
  }
  const updated =
    input.status === "running"
      ? db.markTaskRunning(input.id, clock.now())
      : db.finishTask(input.id, input.status, { error: input.error, result: input.result }, clock.now())
  if (!updated) throw new Error(`task_update: task '${input.id}' vanished`)
  return updated
}

/** Compact JSON-safe projection for tool output (no sqlite internals). */
export function taskSummary(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    payload: t.payload,
    error: t.error,
    result: t.result,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
  }
}
