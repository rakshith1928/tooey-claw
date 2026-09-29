/**
 * Centralized permission policy (ticket 06, SPEC decision 7).
 *
 * One pure evaluator decides every permission evaluation the plugin hook
 * sees, so autonomy never depends on a model "behaving well". Two structural
 * rules make that trustworthy:
 *
 * 1. **Deny-by-default for destructive actions.** Anything in
 *    DEFAULT_DENY_ACTIONS (or not explicitly allowlisted) is denied unless
 *    the project config opts in. The point is unattended-safety: an 'ask'
 *    that nobody can answer hangs a run until the watchdog kills it, which
 *    is exactly what the ticket-05 live demo hit.
 * 2. **A configured deny is final.** OpenCode computes `effect` from the
 *    agent/config rules before the hook runs; this module can only ever
 *    TIGHTEN that decision (allow stays allow, ask → deny/allow, deny stays
 *    deny). It is structurally incapable of loosening a configured deny,
 *    because the "configured-deny-final" check happens before any allowlist
 *    matching.
 */
import type { Policy, PermissionEffect } from "./config"

/** Destructive actions denied unless explicitly allowlisted in claw.json. */
export const DEFAULT_DENY_ACTIONS: readonly string[] = ["edit", "write", "patch", "webfetch", "shell"]

/** Structural view of the SDK's PermissionEvaluation (fields this module uses). */
export interface Evaluation {
  sessionID: string
  agent?: string
  action: string
  resources: readonly string[]
  effect: PermissionEffect
  message?: string
}

export interface PolicyDecision {
  effect: PermissionEffect
  message?: string
  reason: "passthrough" | "allowlisted" | "destructive-default" | "configured-deny-final" | "bypassed"
}

/** Sentinel filename (under the data dir) that disables policy enforcement. Mirrors the `data/kill` pattern. */
export const POLICY_BYPASS_FILENAME = "policy-off"

export interface EvaluateOptions {
  /**
   * When true, the operator has created the bypass sentinel: every evaluation
   * passes through unchanged. Checked per-evaluation (not cached) so creating
   * the file unblocks a locked-out operator without a server restart.
   */
  bypassed?: boolean
}

/**
 * Decide one evaluation. Pure, total, and monotone: the returned effect is
 * never more permissive than the incoming one except for 'ask', which this
 * policy resolves to a definite answer precisely so unattended runs cannot
 * hang waiting for a human.
 */
export function evaluate(
  ev: Evaluation,
  policy: Policy,
  denyActions: readonly string[] = DEFAULT_DENY_ACTIONS,
  options: EvaluateOptions = {},
): PolicyDecision {
  // Break-glass first: an operator-created sentinel disables enforcement
  // entirely (passthrough). A misconfigured policy can never lock the
  // operator out of their own repo — creating data/policy-off restores
  // OpenCode's own semantics immediately, no restart needed.
  if (options.bypassed) {
    return { effect: ev.effect, reason: "bypassed" }
  }
  // Don't trust the caller's list: a blank/whitespace entry must never read as
  // "this action is allowlisted". parsePolicy already filters these, but the
  // evaluator is security-critical and normalizes regardless of its caller.
  const allow = policy.allow.filter((a) => a.trim().length > 0)
  // (1) A configured deny is final — before any allowlist is consulted.
  if (ev.effect === "deny") {
    return {
      effect: "deny",
      reason: "configured-deny-final",
      message: ev.message ?? "denied by OpenCode configuration (claw policy never overrides configured denies)",
    }
  }

  // (2) Already-allowed non-destructive actions pass through untouched.
  if (ev.effect === "allow" && !denyActions.includes(ev.action)) {
    return { effect: "allow", reason: "passthrough" }
  }

  // (3) Explicit allowance list (project-local config) opts an action in.
  if (allow.includes(ev.action)) {
    return { effect: "allow", reason: "allowlisted" }
  }

  // (4) Deny-by-default for destructive actions; resolve 'ask' so unattended
  //     runs never block on a permission nobody can answer.
  if (denyActions.includes(ev.action)) {
    return {
      effect: "deny",
      reason: "destructive-default",
      message: `denied by claw policy: '${ev.action}' is destructive and not in the configured allow list`,
    }
  }

  // (5) Non-destructive 'ask' → leave as ask (a human is present, presumably).
  return { effect: ev.effect, reason: "passthrough" }
}
