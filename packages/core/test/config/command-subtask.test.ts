import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Money } from "@opencode-ai/schema/money"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Command } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { ConfigCommandPlugin } from "@opencode-ai/core/config/plugin/command"
import { Database } from "@opencode-ai/core/database/database"
import { Job } from "@opencode-ai/core/job"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Model } from "@opencode-ai/core/model"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ShellSelect } from "@opencode-ai/core/shell/select"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import { tempGlobalLayer } from "../fixture/global"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const overrideModel = Model.Ref.make({ id: Model.ID.make("override"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Stands in for the model runner: every resume emits one completed assistant text so
// subagent jobs settle without a provider.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("CommandSubtaskTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

// Registers the real config command plugin against the real command registry and Session
// service, so `Session.command` resolves commands through the path production uses.
const commandPluginSupervisor = makeLocationNode({
  name: "test/command-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const sessions = yield* Session.Service
      yield* ConfigCommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: commands.transform,
            reload: commands.reload,
          },
          session: {
            get: (input) => sessions.get(input.sessionID),
            switchAgent: (input) => sessions.switchAgent(input),
            switchModel: (input) => sessions.switchModel(input),
            prompt: (input) => sessions.prompt(input),
          },
        }),
      )
    }),
  ),
  deps: [
    Agent.node,
    AppProcess.node,
    Bus.node,
    Command.node,
    Config.node,
    FSUtil.node,
    Location.node,
    Session.node,
    Job.node,
    ShellSelect.node,
  ],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      PluginSupervisor.node.replace(commandPluginSupervisor),
    ],
  ),
)

const commands = {
  review: { template: "Review $ARGUMENTS", description: "Review", agent: "reviewer" },
  "review-inline": { template: "Review inline", agent: "reviewer", subtask: false },
  "override-model": { template: "Override model", agent: "reviewer", model: "test/override" },
  forced: { template: "Force a child", subtask: true },
  "forced-primary": { template: "Force a primary child", agent: "primary", subtask: true },
  "missing-subtask": { template: "Missing subtask", agent: "ghost", subtask: true },
  "missing-inline": { template: "Missing inline", agent: "ghost" },
  plain: { template: "Plain prompt" },
}

// One tmpdir project whose config declares every command shape under test.
const withProject = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ commands })))
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
        const locations = yield* LocationServiceMap.Service
        yield* Agent.Service.use((agents) =>
          agents.transform((draft) => {
            // The build agent has a configured model that differs from the parent Session's
            // active model, proving a forced subtask without an agent keeps the active model.
            draft.update(Agent.ID.make("build"), (agent) => {
              agent.mode = "primary"
              agent.model = childModel
            })
            draft.update(Agent.ID.make("reviewer"), (agent) => {
              agent.mode = "subagent"
              agent.model = childModel
            })
            draft.update(Agent.ID.make("primary"), (agent) => {
              agent.mode = "primary"
            })
          }),
        ).pipe(Effect.provide(locations.get(location)))
        return yield* body(location)
      }),
    ),
  )

const children = (sessions: Session.Interface, parentID: Session.ID) =>
  sessions.list({ parentID }).pipe(Effect.map((page) => page.data))

// Nothing delivers the admitted prompt in this harness, so assert on the durable inbox
// rather than on projected messages.
const admitted = (sessions: Session.Interface, sessionID: Session.ID) =>
  sessions
    .inbox(sessionID)
    .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "user" ? [item.payload.text] : []))))

const attached = (sessions: Session.Interface, sessionID: Session.ID) =>
  sessions
    .inbox(sessionID)
    .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "user" ? (item.payload.files ?? []) : []))))

const modelRef = (model: Model.Ref) => ({ id: model.id, providerID: model.providerID })

describe("command subtask execution", () => {
  it.live("runs a subagent-mode command in a child session without touching the caller", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "review", text: "the diff" })

        const spawned = yield* children(sessions, parent.id)
        expect(spawned).toHaveLength(1)
        expect(spawned[0]?.agent).toBe(Agent.ID.make("reviewer"))
        expect(spawned[0]?.model).toMatchObject(modelRef(childModel))

        // V1 parity: the caller keeps its own agent and model.
        const after = yield* sessions.get(parent.id)
        expect(after.agent).toBe(Agent.ID.make("build"))
        expect(after.model).toMatchObject(modelRef(parentModel))

        expect(yield* admitted(sessions, spawned[0].id)).toEqual(["Review the diff"])
      }),
    ),
  )

  it.live("keeps a subagent-mode command in the caller when subtask is false", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "review-inline", text: "" })

        expect(yield* children(sessions, parent.id)).toHaveLength(0)
        const after = yield* sessions.get(parent.id)
        expect(after.agent).toBe(Agent.ID.make("reviewer"))
        expect(after.model).toMatchObject(modelRef(childModel))
        expect(yield* admitted(sessions, parent.id)).toEqual(["Review inline"])
      }),
    ),
  )

  it.live("forces a child on the caller's agent and active model when subtask is true without an agent", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "forced", text: "" })

        const spawned = yield* children(sessions, parent.id)
        expect(spawned).toHaveLength(1)
        // The caller's agent is inherited, but its configured model must not override
        // the caller Session's active model.
        expect(spawned[0]?.agent).toBe(Agent.ID.make("build"))
        expect(spawned[0]?.model).toMatchObject(modelRef(parentModel))
      }),
    ),
  )

  it.live("forces a child on a primary-mode agent when subtask is true", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "forced-primary", text: "" })

        const spawned = yield* children(sessions, parent.id)
        expect(spawned).toHaveLength(1)
        expect(spawned[0]?.agent).toBe(Agent.ID.make("primary"))
        expect((yield* sessions.get(parent.id)).agent).toBe(Agent.ID.make("build"))
      }),
    ),
  )

  it.live("lets an explicit command model override the command agent's model", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "override-model", text: "" })

        const spawned = yield* children(sessions, parent.id)
        expect(spawned).toHaveLength(1)
        expect(spawned[0]?.model).toMatchObject(modelRef(overrideModel))
      }),
    ),
  )

  it.live("carries the invocation's attachments into the child session", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({
          sessionID: parent.id,
          command: "review",
          text: "the diff",
          files: [{ uri: `data:text/plain;base64,${Buffer.from("notes").toString("base64")}`, name: "notes.txt" }],
        })

        const spawned = yield* children(sessions, parent.id)
        expect(yield* attached(sessions, spawned[0].id)).toMatchObject([{ name: "notes.txt" }])
      }),
    ),
  )

  it.live("fails a subtask command whose configured agent no longer exists", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        const error = yield* sessions
          .command({ sessionID: parent.id, command: "missing-subtask", text: "" })
          .pipe(Effect.flip)

        expect(error.message).toContain("unknown agent ghost")
        expect(yield* children(sessions, parent.id)).toHaveLength(0)
        expect((yield* sessions.get(parent.id)).agent).toBe(Agent.ID.make("build"))
      }),
    ),
  )

  it.live("fails an inline command whose configured agent no longer exists without switching", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        const error = yield* sessions
          .command({ sessionID: parent.id, command: "missing-inline", text: "" })
          .pipe(Effect.flip)

        expect(error.message).toContain("unknown agent ghost")
        expect((yield* sessions.get(parent.id)).agent).toBe(Agent.ID.make("build"))
        expect(yield* admitted(sessions, parent.id)).toEqual([])
      }),
    ),
  )

  it.live("prompts the caller for a command with neither an agent nor subtask", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "plain", text: "" })

        expect(yield* children(sessions, parent.id)).toHaveLength(0)
        expect(yield* admitted(sessions, parent.id)).toEqual(["Plain prompt"])
      }),
    ),
  )

  it.live("notifies the caller with a running launch notice and a settled completion notice", () =>
    withProject((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* Job.Service
        const parent = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: parentModel })

        yield* sessions.command({ sessionID: parent.id, command: "review", text: "the diff" })
        const spawned = yield* children(sessions, parent.id)
        const childID = spawned[0]?.id
        expect(childID).toBeDefined()

        // The background notification marker survives until the completion notice is admitted.
        yield* jobs.pendingBackground.pipe(Effect.repeat({ until: (pending) => pending.length === 0 }))

        // The launch notice is a projected synthetic on the caller, committed directly (not via
        // the inbox), so it is readable from the projected message list immediately.
        const launch = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
        expect(launch).toHaveLength(1)
        expect(launch[0]).toMatchObject({
          type: "synthetic",
          description: "Review",
          text: `<subagent sessionID="${childID}" state="running" description="Review"></subagent>`,
          metadata: { source: "subagent", command: "review", childID, agent: "reviewer", state: "running" },
        })

        // The settled notice goes through the standard synthetic-inbox path; this harness has no
        // runner to deliver it, so it is asserted on the durable inbox admission.
        const inbox = yield* sessions.inbox(parent.id)
        const settled = inbox.filter((item) => item.type === "synthetic")
        expect(settled).toHaveLength(1)
        expect(settled[0]?.type === "synthetic" && settled[0].payload.metadata).toMatchObject({
          source: "subagent",
          childID,
          agent: "reviewer",
          state: "completed",
        })
        expect(settled[0]?.type === "synthetic" && settled[0].payload.text).toBe(
          `<subagent sessionID="${childID}" state="completed" description="Review">\n${childText}\n</subagent>`,
        )
        expect(yield* jobs.pendingBackground).toEqual([])
      }),
    ),
  )
})
