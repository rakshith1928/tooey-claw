/**
 * SQLite storage (SPEC decision 8): tasks + schedules, WAL mode.
 * All timestamps are injected by the caller (fake-clock discipline —
 * storage code never reads wall time itself).
 */
import { Database } from "bun:sqlite"

/** Binding values we ever need to pass through the query escape hatches. */
type Bind = string | number | null

export type TaskStatus = "queued" | "running" | "done" | "failed"

export interface Task {
  id: string
  type: string
  payload: unknown
  status: TaskStatus
  error: string | null
  result: unknown
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface ScheduleRow {
  id: string
  name: string
  cadence: string
  target: string
  enabled: boolean
  lastDispatchedAt: number | null
}

interface TaskRow {
  id: string
  type: string
  payload_json: string
  status: string
  error: string | null
  result_json: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface ScheduleDbRow {
  id: string
  name: string
  cadence: string
  target: string
  enabled: number
  last_dispatched_at: number | null
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload_json),
    status: r.status as TaskStatus,
    error: r.error,
    result: r.result_json === null ? null : JSON.parse(r.result_json),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export interface ClawDb {
  close(): void
  /** Escape hatch for tests/assertions against the raw schema. */
  query1<T>(sql: string, params?: Bind[]): T | null
  queryAll<T>(sql: string, params?: Bind[]): T[]

  createTask(input: { type: string; payload: unknown }, now: number): Task
  getTask(id: string): Task | null
  /** The running task whose dispatched session is `sessionID`, if any. */
  findRunningBySession(sessionID: string): Task | null
  listRunning(): Task[]
  /** Newest-first task listing for the task tools; filters optional, limit clamped 1..200. */
  listTasks(opts?: { status?: string; type?: string; limit?: number }): Task[]
  /** Most recent done task for a schedule id (source of the next-run pointer). */
  lastDoneFor(scheduleId: string): Task | null
  markTaskRunning(id: string, now: number): Task | null
  finishTask(
    id: string,
    status: "done" | "failed",
    fields: { error?: string; result?: unknown },
    now: number,
  ): Task | null
  /** Record the dispatch target on a running task (ticket 03 adds completion). */
  setTaskSession(id: string, sessionID: string): void

  upsertSchedules(rows: Array<Omit<ScheduleRow, "lastDispatchedAt">>): void
  listSchedules(): ScheduleRow[]
  setLastDispatched(id: string, ts: number): void
}

export function openClawDb(filePath: string): ClawDb {
  const db = new Database(filePath, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
      error TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cadence TEXT NOT NULL,
      target TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_dispatched_at INTEGER
    );
  `)

  // Positional `?` parameters throughout: key-name binding of $params is
  // version-sensitive in bun; positional is not.
  const stmt = {
    insertTask: db.query(
      `INSERT INTO tasks (id, type, payload_json, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
    ),
    getTask: db.query("SELECT * FROM tasks WHERE id = ?"),
    findRunningBySession: db.query(
      `SELECT * FROM tasks
       WHERE status = 'running' AND json_extract(result_json, '$.sessionID') = ?
       LIMIT 1`,
    ),
    listRunning: db.query("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at"),
    lastDoneFor: db.query(
      `SELECT * FROM tasks
       WHERE status = 'done' AND json_extract(payload_json, '$.scheduleId') = ?
       ORDER BY finished_at DESC LIMIT 1`,
    ),
    listTasksAll: db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?"),
    listTasksStatus: db.query("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?"),
    listTasksType: db.query("SELECT * FROM tasks WHERE type = ? ORDER BY created_at DESC LIMIT ?"),
    listTasksStatusType: db.query(
      "SELECT * FROM tasks WHERE status = ? AND type = ? ORDER BY created_at DESC LIMIT ?",
    ),
    runTask: db.query(
      `UPDATE tasks SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`,
    ),
    finishTask: db.query(
      // COALESCE: a finish without a new result preserves what is already on
      // the row (e.g. the session pointer recorded by setTaskSession).
      `UPDATE tasks SET status = ?, error = ?, result_json = COALESCE(?, result_json), finished_at = ?
       WHERE id = ? AND status IN ('queued','running')`,
    ),
    upsertSchedule: db.query(
      `INSERT INTO schedules (id, name, cadence, target, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, cadence = excluded.cadence,
         target = excluded.target, enabled = excluded.enabled`,
    ),
    listSchedules: db.query("SELECT * FROM schedules ORDER BY id"),
    setLastDispatched: db.query(
      "UPDATE schedules SET last_dispatched_at = ? WHERE id = ?",
    ),
    setTaskSession: db.query("UPDATE tasks SET result_json = ? WHERE id = ?"),
  }

  return {
    close: () => db.close(),

    query1: <T>(sql: string, params: Bind[] = []) =>
      (db.query(sql).get(...params) as T | null) ?? null,
    queryAll: <T>(sql: string, params: Bind[] = []) =>
      db.query(sql).all(...params) as T[],

    createTask(input, now) {
      const id = crypto.randomUUID()
      stmt.insertTask.run(id, input.type, JSON.stringify(input.payload ?? {}), now)
      return this.getTask(id)!
    },

    getTask(id) {
      const row = stmt.getTask.get(id) as TaskRow | null
      return row ? toTask(row) : null
    },

    findRunningBySession(sessionID) {
      const row = stmt.findRunningBySession.get(sessionID) as TaskRow | null
      return row ? toTask(row) : null
    },

    listRunning() {
      return (stmt.listRunning.all() as TaskRow[]).map(toTask)
    },

    listTasks(opts = {}) {
      const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 50) || 50))
      const rows =
        opts.status && opts.type
          ? (stmt.listTasksStatusType.all(opts.status, opts.type, limit) as TaskRow[])
          : opts.status
            ? (stmt.listTasksStatus.all(opts.status, limit) as TaskRow[])
            : opts.type
              ? (stmt.listTasksType.all(opts.type, limit) as TaskRow[])
              : (stmt.listTasksAll.all(limit) as TaskRow[])
      return rows.map(toTask)
    },

    lastDoneFor(scheduleId) {
      const row = stmt.lastDoneFor.get(scheduleId) as TaskRow | null
      return row ? toTask(row) : null
    },

    markTaskRunning(id, now) {
      stmt.runTask.run(now, id)
      return this.getTask(id)
    },

    finishTask(id, status, fields, now) {
      if (status !== "done" && status !== "failed") {
        throw new Error(`finishTask: '${status}' is not a terminal status (done|failed)`)
      }
      stmt.finishTask.run(
        status,
        fields.error ?? null,
        fields.result === undefined ? null : JSON.stringify(fields.result),
        now,
        id,
      )
      return this.getTask(id)
    },

    setTaskSession(id, sessionID) {
      stmt.setTaskSession.run(JSON.stringify({ sessionID }), id)
    },

    upsertSchedules(rows) {
      for (const r of rows) {
        stmt.upsertSchedule.run(r.id, r.name, r.cadence, r.target, r.enabled ? 1 : 0)
      }
    },

    listSchedules() {
      return (stmt.listSchedules.all() as ScheduleDbRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        cadence: r.cadence,
        target: r.target,
        enabled: r.enabled === 1,
        lastDispatchedAt: r.last_dispatched_at,
      }))
    },

    setLastDispatched(id, ts) {
      stmt.setLastDispatched.run(ts, id)
    },
  }
}
