import { describe, it, expect } from "bun:test"
import { parseCadence, parseConfig } from "../src/config"

describe("config — parseCadence", () => {
  it("parses minute cadences", () => {
    expect(parseCadence("every:15m")).toBe(15 * 60_000)
  })

  it("parses hour cadences", () => {
    expect(parseCadence("every:2h")).toBe(2 * 3_600_000)
  })

  it("parses day cadences", () => {
    expect(parseCadence("every:1d")).toBe(24 * 3_600_000)
  })

  it("rejects malformed cadences with an actionable message", () => {
    expect(() => parseCadence("15m")).toThrow(/every:/)
    expect(() => parseCadence("every:")).toThrow(/every:/)
    expect(() => parseCadence("every:xm")).toThrow(/every:/)
    expect(() => parseCadence("every:5s")).toThrow(/every:/)
  })
})

describe("config — parseConfig", () => {
  const valid = {
    tickSeconds: 30,
    schedules: [
      {
        id: "watchdog-claw",
        name: "Watch Claw repo",
        repo: "C:\\repos\\claw",
        cadence: "every:15m",
        prompt: "Check the repo for issues, PRs and CI failures since last run.",
      },
    ],
  }

  it("accepts a valid config and resolves cadence ms", () => {
    const cfg = parseConfig(valid)
    expect(cfg.tickMs).toBe(30_000)
    expect(cfg.schedules).toHaveLength(1)
    expect(cfg.schedules[0]!.cadenceMs).toBe(15 * 60_000)
    expect(cfg.schedules[0]!.repo).toBe("C:\\repos\\claw")
  })

  it("defaults tickSeconds when absent", () => {
    const { tickSeconds: _omit, ...noTick } = valid
    expect(parseConfig(noTick).tickMs).toBe(60_000)
  })

  it("rejects duplicate schedule ids", () => {
    const dup = { ...valid, schedules: [valid.schedules[0], { ...valid.schedules[0] }] }
    expect(() => parseConfig(dup)).toThrow(/duplicate schedule id/i)
  })

  it("rejects schedules missing required fields", () => {
    const bad = { schedules: [{ id: "x" }] }
    expect(() => parseConfig(bad)).toThrow(/watchdog-claw|repo|cadence|id/i)
  })

  it("rejects non-object config", () => {
    expect(() => parseConfig(null)).toThrow(/config/)
    expect(() => parseConfig([])).toThrow(/config/)
  })

  it("parses optional top-level dispatch model 'provider/model'", () => {
    const withModel = parseConfig({ ...valid, model: "tokenrouter/qwen/qwen3.8-max-free" })
    expect(withModel.model).toEqual({
      providerID: "tokenrouter",
      modelID: "qwen/qwen3.8-max-free",
    })
    expect(parseConfig(valid).model).toBeUndefined()
    expect(() => parseConfig({ ...valid, model: "nope" })).toThrow(/provider\/model/)
  })
})
