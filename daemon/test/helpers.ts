/**
 * Test doubles for the approved daemon-loop seam (SPEC Testing Decisions):
 * fake clock + recording fake client. No network, no model calls.
 */
import type { ClawOpenCodePort, ClawEvent, ModelRef } from "../src/ports"
import type { Clock } from "../src/ports"

/** Drain all pending microtasks (fake-clock tests: no real sleeping involved). */
export const flush = () => new Promise((r) => setTimeout(r, 0))

export class FakeClock implements Clock {
  time = 0
  private sleepers: Array<{ remaining: number; resolve: () => void }> = []

  now() {
    return this.time
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.sleepers.push({ remaining: ms, resolve }))
  }

  advance(ms: number) {
    this.time += ms
    for (const s of this.sleepers) {
      s.remaining -= ms
      if (s.remaining <= 0) s.resolve()
    }
    this.sleepers = this.sleepers.filter((s) => s.remaining > 0)
  }
}

export interface RecordedPrompt {
  sessionID: string
  text: string
}

/** Minimal ClawOpenCodePort that records dispatches; prompt() is gate-able. */
export function makeFakePort(): {
  port: ClawOpenCodePort
  sessions: Array<{ directory: string; agent?: string; title?: string; model?: ModelRef }>
  prompts: RecordedPrompt[]
  /** Run synchronously at prompt() entry, BEFORE the gate — for DB-state-at-dispatch assertions. */
  beforePrompt(fn: () => void): void
  /** Arm the gate: the NEXT prompt() call blocks until open() is called. */
  armGate(): { open: () => void }
  /** Block the NEXT wait() call until open() — models a worker still running. */
  armWaitGate(): { open: () => void }
  /** Sessions whose wait() has resolved (worker finished). */
  readonly waited: string[]
  /** Sessions passed to interrupt() (timeout / cancellation path). */
  readonly interrupted: string[]
  /** Canned transcript lines returned by port.transcript(). */
  setTranscript(lines: string[]): void
  /** Feed events into port.events() (the fake server event stream). */
  emit(...events: ClawEvent[]): void
  /** End the event stream (watchers finish). */
  closeEvents(): void
} {
  const sessions: Array<{ directory: string; agent?: string; title?: string; model?: ModelRef }> = []
  const prompts: RecordedPrompt[] = []
  const enterHooks: Array<() => void> = []
  let armed: Promise<void> | null = null
  let openGate: () => void = () => {}
  let armedWait: Promise<void> | null = null
  let openWait: () => void = () => {}
  const waited: string[] = []
  const interrupted: string[] = []
  let transcript: string[] = []
  const eventQueue: ClawEvent[] = []
  let eventWaiter: (() => void) | null = null
  let eventsOpen = true

  const port = {
    async healthy() {
      return true
    },
    async agents() {
      return []
    },
    async plugins() {
      return []
    },
    async createSession(input: {
      directory: string
      agent?: string
      title?: string
      model?: ModelRef
    }) {
      sessions.push(input)
      return { sessionID: `ses_${sessions.length}` }
    },
    async prompt(sessionID: string, text: string) {
      for (const fn of enterHooks) fn()
      if (armed) await armed
      prompts.push({ sessionID, text })
    },
    async wait(sessionID: string) {
      const gate = armedWait
      armedWait = null
      if (gate) await gate
      waited.push(sessionID)
    },
    async interrupt(sessionID: string) {
      interrupted.push(sessionID)
    },
    async transcript() {
      return transcript
    },
    async *events(): AsyncIterable<ClawEvent> {
      while (true) {
        while (eventQueue.length > 0) yield eventQueue.shift()!
        if (!eventsOpen) return
        await new Promise<void>((resolve) => {
          eventWaiter = () => {
            eventWaiter = null
            resolve()
          }
        })
      }
    },
  } as unknown as ClawOpenCodePort

  return {
    port,
    sessions,
    prompts,
    waited,
    interrupted,
    beforePrompt: (fn) => enterHooks.push(fn),
    armGate() {
      armed = new Promise<void>((resolve) => {
        openGate = resolve
      })
      return { open: () => openGate() }
    },
    armWaitGate() {
      armedWait = new Promise<void>((resolve) => {
        openWait = resolve
      })
      return { open: () => openWait() }
    },
    setTranscript(lines) {
      transcript = lines
    },
    emit(...events) {
      eventQueue.push(...events)
      eventWaiter?.()
    },
    closeEvents() {
      eventsOpen = false
      eventWaiter?.()
    },
  }
}
