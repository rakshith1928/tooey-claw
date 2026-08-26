import { describe, it, expect } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { canonical, ensureDataDir, DATA_DIR, CLAW_ROOT, resolveDataDir, isClawRoot } from "../src/paths"

describe("paths — canonical", () => {
  it("resolves a relative path to an absolute path", () => {
    const rel = path.join("a", "b")
    const got = canonical(rel)
    expect(path.isAbsolute(got)).toBe(true)
    expect(got).toBe(path.resolve(rel))
  })

  it("returns absolute path canonicalized (no throw for existing dir)", () => {
    const abs = CLAW_ROOT
    const got = canonical(abs)
    expect(path.isAbsolute(got)).toBe(true)
    expect(got).toBe(path.resolve(abs))
  })

  it("handles non-existent path gracefully by falling back to resolve", () => {
    const missing = path.join(CLAW_ROOT, "__does_not_exist__", "x")
    expect(existsSync(missing)).toBe(false)
    const got = canonical(missing)
    expect(got).toBe(path.resolve(missing))
  })
})

describe("paths — DATA_DIR", () => {
  it("derives DATA_DIR from CLAW_ROOT by default", () => {
    expect(DATA_DIR).toBe(path.join(CLAW_ROOT, "data"))
  })

  it("ensureDataDir creates the directory and is idempotent", () => {
    const beforeExists = existsSync(DATA_DIR)
    const returned = ensureDataDir()
    expect(returned).toBe(DATA_DIR)
    expect(existsSync(DATA_DIR)).toBe(true)
    const second = ensureDataDir()
    expect(second).toBe(DATA_DIR)
    if (!beforeExists) {
      // Leave it for other tests; do not delete real DATA_DIR
    }
  })
})

describe("paths — resolveDataDir", () => {
  it("uses CLAW_DATA_DIR env when provided", () => {
    const custom = path.join(CLAW_ROOT, "custom-data")
    expect(resolveDataDir(CLAW_ROOT, custom)).toBe(path.resolve(custom))
  })

  it("falls back to <root>/data when env is undefined", () => {
    expect(resolveDataDir(CLAW_ROOT, undefined)).toBe(path.join(CLAW_ROOT, "data"))
  })

  it("falls back when env is empty string", () => {
    expect(resolveDataDir(CLAW_ROOT, "")).toBe(path.join(CLAW_ROOT, "data"))
  })
})

describe("paths — isClawRoot", () => {
  it("recognizes the current Claw root (has .opencode and package.json)", () => {
    expect(isClawRoot(CLAW_ROOT)).toBe(true)
  })

  it("rejects a directory without package.json", () => {
    const tmp = path.join(CLAW_ROOT, "__does_not_exist__")
    expect(isClawRoot(tmp)).toBe(false)
  })

  it("rejects parent of claw root (no .opencode, different package)", () => {
    const parent = path.dirname(CLAW_ROOT)
    // Parent C:\Users\DELL may have no package.json or different package — should be false
    // We assert it is not considered a Claw root even if it has a package.json
    if (parent !== CLAW_ROOT) {
      expect(isClawRoot(parent)).toBe(false)
    }
  })
})
