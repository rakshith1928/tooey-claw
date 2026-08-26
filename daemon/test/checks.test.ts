import { describe, it, expect } from "bun:test"
import { findMissingAgents, findClawAgentLeak, hasPlugin } from "../src/checks"
import type { AgentSummary, PluginSummary } from "../src/ports"

const agent = (id: string): AgentSummary => ({ id })
const pluginById = (id: string): PluginSummary => ({ id })
const pluginByName = (name: string): PluginSummary => ({ name })

describe("checks — findMissingAgents", () => {
  it("reports nothing when all required agents are present", () => {
    const seen = [agent("claw"), agent("worker"), agent("build")]
    expect(findMissingAgents(["claw", "worker"], seen)).toEqual([])
  })

  it("reports required agents that are absent", () => {
    const seen = [agent("build"), agent("plan")]
    expect(findMissingAgents(["claw", "worker"], seen)).toEqual(["claw", "worker"])
  })

  it("reports only the actually missing one", () => {
    const seen = [agent("claw")]
    expect(findMissingAgents(["claw", "worker"], seen)).toEqual(["worker"])
  })
})

describe("checks — findClawAgentLeak", () => {
  it("flags claw and worker by exact id", () => {
    const seen = [agent("build"), agent("claw"), agent("worker")]
    expect(findClawAgentLeak(seen).map((a) => a.id)).toEqual(["claw", "worker"])
  })

  it("does not flag unrelated agents", () => {
    const seen = [agent("build"), agent("general"), agent("plan")]
    expect(findClawAgentLeak(seen)).toEqual([])
  })

  it("does not flag substring look-alikes (exact match only)", () => {
    const seen = [agent("clawbot"), agent("myworker"), agent("side-claw-x"), agent("claw-core")]
    expect(findClawAgentLeak(seen)).toEqual([])
  })
})

describe("checks — hasPlugin", () => {
  it("matches a plugin by exact id", () => {
    expect(hasPlugin([pluginById("opencode.vcs.git"), pluginById("claw-core")], "claw-core")).toBe(true)
  })

  it("matches by name when id is absent", () => {
    expect(hasPlugin([pluginByName("claw-core")], "claw-core")).toBe(true)
  })

  it("does not substring-match look-alike plugin ids", () => {
    const plugins = [pluginById("my-claw-core-x"), pluginById("claw-core-extra"), pluginById("core")]
    expect(hasPlugin(plugins, "claw-core")).toBe(false)
  })

  it("is false for an empty list", () => {
    expect(hasPlugin([], "claw-core")).toBe(false)
  })

  it("ignores entries with neither id nor name", () => {
    expect(hasPlugin([{}, pluginById("claw-core")], "claw-core")).toBe(true)
    expect(hasPlugin([{}], "claw-core")).toBe(false)
  })
})
