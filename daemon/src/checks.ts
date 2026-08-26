/**
 * Pure acceptance-check predicates for boot verification (ticket 01).
 *
 * Extracted from index.ts so the isolation/registration acceptance rules are
 * unit-testable without a live OpenCode service. All matching is EXACT on
 * ids — substring matching on joined strings caused false passes.
 */
import type { AgentSummary, PluginSummary } from "./ports"

const CLAW_AGENT_IDS = new Set(["claw", "worker"])

/** Required agent ids not present in `seen` (reported in required order). */
export function findMissingAgents(required: readonly string[], seen: AgentSummary[]): string[] {
  const ids = new Set(seen.map((a) => a.id))
  return required.filter((id) => !ids.has(id))
}

/** Agents visible at a location that must only exist inside the Claw root. */
export function findClawAgentLeak(seen: AgentSummary[]): AgentSummary[] {
  return seen.filter((a) => CLAW_AGENT_IDS.has(a.id))
}

/** Whether a plugin with this exact id (or name, when id is absent) is loaded. */
export function hasPlugin(plugins: PluginSummary[], id: string): boolean {
  return plugins.some((p) => (p.id ?? p.name) === id)
}
