import { describe, it, expect } from "bun:test"
import { DEFAULT_DENY_ACTIONS, evaluate, type Evaluation } from "../src/policy"
import type { Policy } from "../src/config"

/**
 * Ticket 06: centralized permission policy. The hook is the ONLY place that
 * decides; the evaluator below is that decision, kept pure so every rule is
 * provable with fabricated evaluation events and no server.
 */

/** Fabricated evaluation event, shaped like PermissionEvaluation. */
function ev(over: Partial<Evaluation> = {}): Evaluation {
  return { sessionID: "ses_1", action: "shell", resources: ["*"], effect: "ask", ...over }
}

const strict: Policy = { allow: [] }

describe("policy — deny-by-default (ticket: destructive action denied centrally)", () => {
  it("denies a destructive action that OpenCode left as 'ask' (unattended-safe default)", () => {
    const r = evaluate(ev({ action: "shell" }), strict)
    expect(r.effect).toBe("deny")
    expect(r.message).toMatch(/denied by claw policy/i)
    expect(r.reason).toBe("destructive-default")
  })

  it("denies every action in the default destructive set", () => {
    for (const action of ["edit", "write", "patch", "webfetch", "shell"]) {
      expect(evaluate(ev({ action }), strict).effect, action).toBe("deny")
    }
  })

  it("does NOT touch read-only actions (they pass through unchanged)", () => {
    const r = evaluate(ev({ action: "read" }), strict)
    expect(r.effect).toBe("ask")
    expect(r.reason).toBe("passthrough")
    expect(evaluate(ev({ action: "glob" }), strict).effect).toBe("ask")
  })

  it("a non-destructive action already allowed by OpenCode stays allowed", () => {
    const r = evaluate(ev({ action: "read", effect: "allow" }), strict)
    expect(r.effect).toBe("allow")
    expect(r.reason).toBe("passthrough")
  })
})

describe("policy — configured denies are final (ticket: never overridden by the hook)", () => {
  it("never upgrades a configured deny to allow, even when allowlisted", () => {
    const p: Policy = { allow: ["shell"] }
    const r = evaluate(ev({ action: "shell", effect: "deny" }), p)
    expect(r.effect).toBe("deny")
    expect(r.reason).toBe("configured-deny-final")
  })

  it("an allowlist entry cannot turn a configured deny into an allow — with a different resource either", () => {
    const p: Policy = { allow: ["shell", "read"] }
    expect(evaluate(ev({ action: "shell", effect: "deny", resources: ["other"] }), p).effect).toBe("deny")
    expect(evaluate(ev({ action: "read", effect: "deny" }), p).effect).toBe("deny")
  })
})

describe("policy — explicit allowance list (ticket: allowlisted actions pass)", () => {
  it("allowlisted destructive action is allowed (no 'ask' hang for unattended runs)", () => {
    const p: Policy = { allow: ["shell"] }
    const r = evaluate(ev({ action: "shell", effect: "ask" }), p)
    expect(r.effect).toBe("allow")
    expect(r.reason).toBe("allowlisted")
  })

  it("allowlist is action-scoped, not a blanket allow", () => {
    const p: Policy = { allow: ["shell"] }
    expect(evaluate(ev({ action: "edit" }), p).effect).toBe("deny")
  })

  it("ignores blank/whitespace entries instead of trusting them", () => {
    const p: Policy = { allow: ["shell", "  ", ""] }
    // A blank entry allowlists nothing: the destructive default still applies…
    expect(evaluate(ev({ action: "edit" }), p).effect).toBe("deny")
    expect(evaluate(ev({ action: "shell" }), p).effect).toBe("allow")
    // …and a blank/whitespace ACTION is never itself allowlisted (not "ask"-turned-deny
    // just because it matched a blank entry — it isn't a destructive action at all).
    expect(evaluate(ev({ action: "  " }), p).reason).toBe("passthrough")
  })
})

describe("policy — shape guardrails", () => {
  it("exported default deny set covers exactly the destructive actions", () => {
    expect([...DEFAULT_DENY_ACTIONS].sort()).toEqual(["edit", "patch", "shell", "webfetch", "write"])
  })
})

describe("policy — break-glass bypass (operator lockout escape hatch)", () => {
  it("bypassed evaluations pass through unchanged, even destructive ask", () => {
    const r = evaluate(ev({ action: "shell", effect: "ask" }), strict, undefined, { bypassed: true })
    expect(r.effect).toBe("ask")
    expect(r.reason).toBe("bypassed")
  })

  it("bypass never upgrades a configured deny either — it restores OpenCode semantics exactly", () => {
    const r = evaluate(ev({ action: "shell", effect: "deny" }), strict, undefined, { bypassed: true })
    expect(r.effect).toBe("deny")
    expect(r.reason).toBe("bypassed")
  })

  it("bypass passes an allow through as allow", () => {
    const r = evaluate(ev({ action: "read", effect: "allow" }), strict, undefined, { bypassed: true })
    expect(r.effect).toBe("allow")
    expect(r.reason).toBe("bypassed")
  })
})
