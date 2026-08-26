/**
 * Production Clock (SPEC decision 9): loop logic gets time only through
 * this port; tests use the fake. This is the ONLY module allowed to touch
 * real wall time.
 */
import type { Clock } from "./ports"

export const SystemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}
