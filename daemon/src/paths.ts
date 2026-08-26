/**
 * Path resolution — strict project-local isolation (SPEC decision 3).
 * Every durable artifact lives under the Claw root; global config is never touched.
 */
import { mkdirSync } from "node:fs"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Walk up from a start dir until a directory containing package.json is found. */
function findRoot(start: string): string {
  let dir = path.resolve(start)
  while (true) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`Could not locate Claw root above ${start}`)
    dir = parent
  }
}

// daemon/src/paths.ts → root is three levels up from this file's directory.
const here = path.dirname(fileURLToPath(import.meta.url))
export const CLAW_ROOT = process.env.CLAW_ROOT ? path.resolve(process.env.CLAW_ROOT) : findRoot(here)

export const DATA_DIR = path.join(CLAW_ROOT, "data")
export const DB_PATH = path.join(DATA_DIR, "claw.db")
export const KILL_SWITCH_PATH = path.join(DATA_DIR, "kill")

/** Ensure the data directory exists; safe to call repeatedly. */
export function ensureDataDir(): string {
  mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}
