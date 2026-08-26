/**
 * Path resolution — strict project-local isolation (SPEC decision 3).
 * Every durable artifact lives under the Claw root; global config is never touched.
 */
import { mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Return canonical absolute path (resolves symlinks / Docker bind mounts). */
export function canonical(p: string): string {
  try {
    return realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

export function resolveDataDir(clawRoot: string, envValue: string | undefined): string {
  return envValue ? path.resolve(envValue) : path.join(clawRoot, "data")
}

export function isClawRoot(dir: string): boolean {
  if (!existsSync(path.join(dir, "package.json"))) return false
  if (existsSync(path.join(dir, ".opencode"))) return true
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    return pkg.name === "claw"
  } catch {
    return false
  }
}

/** Walk up from start dirs until a Claw root is found. */
function findRoot(start: string): string {
  const bases = [start, process.cwd()]
  for (const base of bases) {
    let dir = path.resolve(base)
    while (true) {
      if (isClawRoot(dir)) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // Fallback: any package.json (covers compiled binary / renamed installs)
  for (const base of bases) {
    let dir = path.resolve(base)
    while (true) {
      if (existsSync(path.join(dir, "package.json"))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error(`Could not locate Claw root above ${start} or cwd ${process.cwd()}`)
}

// daemon/src/paths.ts → root is three levels up from this file's directory.
const here = path.dirname(fileURLToPath(import.meta.url))
export const CLAW_ROOT = canonical(
  process.env.CLAW_ROOT ? process.env.CLAW_ROOT : findRoot(here),
)

export const DATA_DIR = resolveDataDir(CLAW_ROOT, process.env.CLAW_DATA_DIR)
export const DB_PATH = path.join(DATA_DIR, "claw.db")
export const KILL_SWITCH_PATH = path.join(DATA_DIR, "kill")

/** Ensure the data directory exists; safe to call repeatedly. */
export function ensureDataDir(): string {
  mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}
