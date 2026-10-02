/**
 * SQLite storage (SPEC decision 8): tasks + schedules + memory, WAL mode.
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

/**
 * Persistent memory entry (ticket 07). Plain data only — the interface says
 * nothing about FTS5, BM25, or triggers; a future embedding/vector backend
 * implements these same two methods without touching callers.
 */
export interface MemoryEntry {
  id: string
  text: string
  tags: string[]
  createdAt: number
}

export interface MemorySaveInput {
  text: string
  tags?: string[]
}

export interface MemorySearchOptions {
  /** Entries must carry ALL of these tags. */
  tags?: string[]
  limit?: number
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

interface MemoryRow {
  id: string
  text: string
  tags: string
  created_at: number
}

function toMemoryEntry(r: MemoryRow): MemoryEntry {
  return { id: r.id, text: r.text, tags: JSON.parse(r.tags) as string[], createdAt: r.created_at }
}

/** Normalize tags: trim, drop blanks, dedupe preserving order. */
function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags ?? []) {
    const tag = t.trim()
    if (tag.length === 0 || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * Quote each whitespace-separated token so user input can never break FTS5
 * syntax (parens, quotes, AND/OR become literal text, joined by implicit AND).
 */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ")
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
  /** The still-running task for a schedule, if any (in-flight guard, ticket 05). */
  findRunningForSchedule(scheduleId: string): Task | null
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

  /** Save one memory entry (tags optional, default []). */
  memorySave(input: MemorySaveInput, now: number): MemoryEntry
  /** Fetch one entry by id (null when unknown). */
  memoryGet(id: string): MemoryEntry | null
  /** Keyword search over text+tags (BM25-ranked), optionally narrowed by tags. */
  memorySearch(query: string, opts?: MemorySearchOptions): MemoryEntry[]
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
  // Memory store (ticket 07, SPEC decision 8): content table + external-content
  // FTS5 index over text+tags, kept in sync by triggers. All three DDLs are
  // IF NOT EXISTS / DROP-then-CREATE, so reopening (restart) never duplicates
  // or throws. Callers only ever see memorySave/memorySearch — MATCH, bm25,
  // and trigger names never leave this module.
  db.run(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, tags, content='memory', content_rowid='rowid');
  `)
  db.run(`DROP TRIGGER IF EXISTS memory_ai`)
  db.run(`DROP TRIGGER IF EXISTS memory_ad`)
  db.run(`DROP TRIGGER IF EXISTS memory_au`)
  db.run(`
    CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
    END;
  `)
  db.run(`
    CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    END;
  `)
  db.run(`
    CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
      INSERT INTO memory_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
    END;
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
    findRunningForSchedule: db.query(
      `SELECT * FROM tasks
       WHERE status = 'running' AND json_extract(payload_json, '$.scheduleId') = ?
       ORDER BY created_at DESC LIMIT 1`,
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
    insertMemory: db.query(
      `INSERT INTO memory (id, text, tags, created_at) VALUES (?, ?, ?, ?)`,
    ),
    getMemory: db.query("SELECT * FROM memory WHERE id = ?"),
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

    findRunningForSchedule(scheduleId) {
      const row = stmt.findRunningForSchedule.get(scheduleId) as TaskRow | null
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

    memorySave(input, now) {
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        throw new Error("memorySave: 'text' must be a non-empty string")
      }
      const id = crypto.randomUUID()
      const tags = cleanTags(input.tags)
      stmt.insertMemory.run(id, input.text, JSON.stringify(tags), now)
      return this.memoryGet(id)!
    },

    memoryGet(id) {
      const row = (stmt.getMemory.get(id) as MemoryRow | null) ?? null
      return row ? toMemoryEntry(row) : null
    },

    memorySearch(query, opts = {}) {
      const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 10) || 10))
      const tags = cleanTags(opts.tags)
      const tagFilter = tags.map(() => `EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)`).join(" AND ")
      const match = toFtsQuery(query)
      if (match.length > 0) {
        const where = [`memory_fts MATCH ?`, ...(tagFilter ? [tagFilter] : [])].join(" AND ")
        const rows = db
          .query(
            `SELECT m.* FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
             WHERE ${where} ORDER BY bm25(memory_fts) LIMIT ?`,
          )
          .all(match, ...tags, limit) as MemoryRow[]
        return rows.map(toMemoryEntry)
      }
      const where = tagFilter.length > 0 ? `WHERE ${tagFilter}` : ""
      const rows = db
        .query(`SELECT m.* FROM memory m ${where} ORDER BY m.created_at DESC LIMIT ?`)
        .all(...tags, limit) as MemoryRow[]
      return rows.map(toMemoryEntry)
    },
  }
}
