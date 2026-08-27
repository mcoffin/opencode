import { describe, expect } from "bun:test"
import { Message, SystemPart } from "@opencode-ai/ai"
import type { ShellCreateBefore, ShellSandbox } from "@opencode-ai/plugin/effect/shell"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Layer } from "effect"
import { PluginHooks } from "../src/plugin/hooks"
import { testEffect } from "./lib/effect"

const layer = PluginHooks.node.implementation as Layer.Layer<PluginHooks.Service>
const it = testEffect(layer)

describe("PluginHooks", () => {
  it.effect("registers scoped session hooks and triggers them sequentially", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          seen.push("first")
          event.system.push(SystemPart.make("second"))
        }),
      )
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          seen.push(event.system[1]?.text ?? "missing")
          event.messages = [Message.user("changed")]
        }),
      )
      const event = {
        sessionID: Session.ID.make("ses_hooks"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
        system: [SystemPart.make("first")],
        messages: [Message.user("original")],
        tools: {},
        generation: {},
        providerOptions: {},
      }

      expect(yield* hooks.trigger("session", "context", event)).toBe(event)
      expect(seen).toEqual(["first", "second"])
      expect(event.messages).toEqual([Message.user("changed")])
    }),
  )

  it.effect("mutates shell creation input", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("shell", "create.before", (event) =>
        Effect.sync(() => {
          event.command = "echo changed"
        }),
      )
      const event: ShellCreateBefore = {
        command: "echo original",
        cwd: "/tmp",
        timeout: 0,
        shell: "/bin/sh",
        env: {},
        source: { type: "user", sessionID: Session.ID.make("ses_hooks") },
      }

      expect(yield* hooks.trigger("shell", "create.before", event)).toBe(event)
      expect(event.command).toBe("echo changed")
    }),
  )

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
        source: {
          type: "tool",
          sessionID: Session.ID.make("ses_hooks"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_hooks"),
          toolCallID: Tool.CallID.make("call_hooks"),
        },
      }

      expect(yield* hooks.trigger("shell", "sandbox", event)).toBe(event)
      expect(event.command).toBe("firejail -- echo original --seen-in=/tmp")
      expect(event.env).toEqual({ SANDBOX: "1" })
    }),
  )
})
