/**
 * Port definitions — THE seam of this codebase (SPEC.md, Testing Decisions).
 *
 * Everything the daemon wants to do to OpenCode goes through ClawOpenCodePort;
 * everything that depends on wall-clock time goes through Clock. Production
 * wires real implementations; tests wire fakes. No other module may import
 * @opencode-ai/* directly (beta-churn firewall, SPEC decision 2).
 */

/**
 * Normalized event from the OpenCode server event stream (verified against
 * client beta types): lifecycle events carry at least a sessionID in `data`.
 */
export interface ClawEvent {
  type: string
  sessionID?: string
  /** Raw event payload, kept for defensive field extraction by the firewall. */
  data?: Record<string, unknown>
}

export interface AgentSummary {
  id: string
  mode?: string
}

export interface PluginSummary {
  id?: string
  name?: string
}

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface CreateSessionInput {
  /** Project directory the session runs in (determines which agents/plugins apply). */
  directory: string
  agent?: string
  title?: string
  /** Optional explicit model so unattended runs never depend on server-side defaults. */
  model?: ModelRef
}

export interface ClawOpenCodePort {
  /** Cheap liveness probe against the server. */
  healthy(): Promise<boolean>

  /**
   * All agents visible to the server, optionally scoped to a location.
   * Scoping is how isolation is verified: Claw agents exist only for the
   * Claw root location, per OpenCode's per-directory discovery.
   */
  agents(directory?: string): Promise<AgentSummary[]>

  /**
   * Plugins loaded for a directory, or `undefined` when the endpoint is
   * unavailable in this client/server version (beta surface).
   */
  plugins(directory: string): Promise<PluginSummary[] | undefined>

  createSession(input: CreateSessionInput): Promise<{ sessionID: string }>
  prompt(sessionID: string, text: string): Promise<void>
  /** Resolves when the session finishes processing its inbox. */
  wait(sessionID: string): Promise<void>
  interrupt(sessionID: string): Promise<void>

  /**
   * Assistant-visible transcript lines for a session (newest last).
   * Used by the probe to recover tool outputs; not on the hot loop path.
   */
  transcript(sessionID: string): Promise<string[]>

  /** Subscribe to the server event stream. */
  events(): AsyncIterable<ClawEvent>
}

/** Injectable clock — never call Date.now()/setTimeout directly in loop logic. */
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}
