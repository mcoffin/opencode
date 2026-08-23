import { describe, expect } from "bun:test"
import type { ShellSandbox } from "@opencode-ai/plugin/effect/shell"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Effect } from "effect"
import { PluginHooks } from "../src/plugin/hooks"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(PluginHooks.node))

describe("PluginHooks", () => {
  it.effect("chains shell sandbox rewrites of the command and env", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("shell", "sandbox", (event) =>
        Effect.sync(() => {
          event.command = `firejail -- ${event.command}`
        }),
      )
      yield* hooks.register("shell", "sandbox", (event) =>
        Effect.sync(() => {
          event.command = `${event.command} --seen-in=${event.cwd}`
          event.env = { ...event.env, SANDBOX: "1" }
        }),
      )
      const event: ShellSandbox = {
        command: "echo original",
        env: {},
        cwd: "/tmp",
        timeout: 0,
        shell: "/bin/sh",
      }

      expect(yield* hooks.trigger("shell", "sandbox", event)).toBe(event)
      expect(event.command).toBe("firejail -- echo original --seen-in=/tmp")
      expect(event.env).toEqual({ SANDBOX: "1" })
    }),
  )
})
