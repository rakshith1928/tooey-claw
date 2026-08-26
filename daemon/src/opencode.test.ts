import { describe, it, expect } from "bun:test"
import path from "node:path"
import { isCompatibleVersion, toLocationDir, resolveCandidates } from "./opencode"

describe("opencode — isCompatibleVersion", () => {
  it("accepts 0.x beta versions", () => {
    expect(isCompatibleVersion("0.0.0-beta-18286")).toBe(true)
    expect(isCompatibleVersion("0.1.0")).toBe(true)
  })

  it("accepts 2.x versions", () => {
    expect(isCompatibleVersion("2.0.0")).toBe(true)
    expect(isCompatibleVersion("2.3.1-beta.1")).toBe(true)
  })

  it("rejects incompatible majors", () => {
    expect(isCompatibleVersion("1.0.0")).toBe(false)
    expect(isCompatibleVersion("3.0.0")).toBe(false)
    expect(isCompatibleVersion("")).toBe(false)
  })
})

describe("opencode — toLocationDir", () => {
  it("returns an absolute canonical path for relative input", () => {
    const rel = path.join("a", "b")
    const got = toLocationDir(rel)
    expect(path.isAbsolute(got)).toBe(true)
    expect(got).toBe(path.resolve(rel))
  })

  it("canonicalizes an existing absolute directory", () => {
    const abs = path.resolve(".")
    const got = toLocationDir(abs)
    expect(path.isAbsolute(got)).toBe(true)
  })
})

describe("opencode — resolveCandidates", () => {
  it("returns single env bin when provided", () => {
    expect(resolveCandidates("my-opencode")).toEqual(["my-opencode"])
  })

  it("falls back to stable then beta when env is undefined", () => {
    expect(resolveCandidates(undefined)).toEqual(["opencode", "opencode2"])
  })

  it("falls back when env is empty string", () => {
    // Empty string is falsy — should still fallback
    expect(resolveCandidates("")).toEqual(["opencode", "opencode2"])
  })
})

describe("opencode — toWireModel", () => {
  it("maps ModelRef {providerID, modelID} to wire {providerID, id}", async () => {
    const { toWireModel } = await import("./opencode")
    expect(toWireModel({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    })
  })

  it("returns undefined for undefined input", async () => {
    const { toWireModel } = await import("./opencode")
    expect(toWireModel(undefined)).toBeUndefined()
  })
})
