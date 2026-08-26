/**
 * claw-core — the in-server Claw plugin.
 *
 * Owns everything that must live INSIDE OpenCode sessions (per spec decision 1):
 * - custom tools for the agents (probe in ticket 01; task/memory/delegate later)
 * - context injection + permission hooks (tickets 06/08)
 *
 * Loaded automatically because it sits under .opencode/plugins/.
 */
import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "claw-core",
  async setup(ctx) {
    console.log(`[claw-core] loaded (OpenCode ${ctx.app.version})`)

    await ctx.tool.transform((draft) => {
      draft.add({
        name: "claw_probe",
        description: "Verify the claw-core plugin is alive inside a session",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "claw" },
        execute: async () => {
          return { content: `claw-core OK (OpenCode ${ctx.app.version})` }
        },
      })
    })

    // Later tickets register task/memory/delegate tools and the
    // session-context + permission-evaluation hooks here.
    return () => console.log("[claw-core] unloaded")
  },
})
