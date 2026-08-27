export * as Subagent from "./subagent.js"

import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Effect, Scope } from "effect"
import type { Agent } from "./agent.js"
import type { Job } from "./job.js"
import type { Model } from "./model.js"
import type { Session } from "./session.js"
import type { SessionSchema } from "./session/schema.js"

const NO_TEXT = "Subagent completed without a text response."

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export type Runtime = {
  readonly session: Pick<Session.Interface, "create" | "messages" | "prompt" | "resume" | "interrupt" | "synthetic">
  readonly job: Pick<Job.Interface, "start" | "wait" | "block" | "background" | "cancel" | "completeBackground">
}

export interface Input {
  readonly runtime: Runtime
  readonly scope: Scope.Scope
  readonly parentID: SessionSchema.ID
  readonly agent: Agent.Info
  readonly title: string
  readonly prompt: string
  readonly files?: PromptInput.Prompt["files"]
  readonly agents?: PromptInput.Prompt["agents"]
  readonly skills?: PromptInput.Prompt["skills"]
  readonly model?: Model.Ref
  /** Continue this already-validated child instead of creating one. */
  readonly existing?: SessionSchema.Info
  readonly background: boolean
  readonly progress?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly metadata?: Record<string, unknown>
}

// One completion observer per job generation. Keyed by child plus start time so a fresh
// continuation job is observable even while a settled generation's observer is finalizing.
const notifications = new Set<string>()

export const run = Effect.fn("Subagent.run")(function* (input: Input) {
  const child =
    input.existing ??
    (yield* input.runtime.session.create({
      parentID: input.parentID,
      title: input.title,
      agent: input.agent.id,
      model: input.model,
    }))
  yield* input.progress?.(child.id) ?? Effect.void

  // Standard prompt admission outside the job: Job.start joining a running child skips
  // its run effect, and the default wake starts an idle child or steers a running one.
  yield* input.runtime.session.prompt({
    sessionID: child.id,
    text: input.prompt,
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.agents === undefined ? {} : { agents: input.agents }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.background && input.existing === undefined ? { resume: false } : {}),
  })

  const info = yield* input.runtime.job.start({
    id: child.id,
    type: "subagent",
    title: input.title,
    metadata: input.metadata ?? {},
    recovery: {
      kind: "subagent",
      parentSessionID: input.parentID,
      childSessionID: child.id,
      agent: input.agent.name,
      description: input.title,
    },
    run: input.runtime.session.resume(child.id).pipe(Effect.andThen(latestAssistantText(input, child.id))),
  })

  if (input.background) {
    yield* input.runtime.job.background(info.id)
    yield* notifyWhenDone(input, child.id, info.started_at)
    return backgroundResult(child.id)
  }

  const result = yield* input.runtime.job
    .block({ id: child.id, sessionID: input.parentID })
    .pipe(
      Effect.onInterrupt(() =>
        Effect.all([input.runtime.session.interrupt(child.id), input.runtime.job.cancel(child.id)], { discard: true }),
      ),
    )
  if (result?.type === "backgrounded") {
    yield* notifyWhenDone(input, child.id, result.info.started_at)
    return backgroundResult(child.id)
  }
  if (result?.info.status === "error")
    return { sessionID: child.id, status: "error" as const, output: result.info.error ?? "Subagent failed" }
  if (result?.info.status === "cancelled")
    return { sessionID: child.id, status: "cancelled" as const, output: "Subagent cancelled" }
  return { sessionID: child.id, status: "completed" as const, output: result?.info.output ?? NO_TEXT }
})

// Concatenate the child's final completed assistant text. Distinguishes "completed with no
// text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
const latestAssistantText = Effect.fn("Subagent.latestAssistantText")(function* (
  input: Input,
  sessionID: SessionSchema.ID,
) {
  const messages = yield* input.runtime.session.messages({ sessionID, order: "desc", limit: 20 })
  const assistant = messages.find(
    (message) => message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
  )
  if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
  const text = assistant.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
  return text.length > 0 ? text : NO_TEXT
})

const notifyWhenDone = Effect.fn("Subagent.notifyWhenDone")(function* (
  input: Input,
  childID: SessionSchema.ID,
  startedAt: number,
) {
  const key = `${childID}:${startedAt}`
  if (notifications.has(key)) return
  notifications.add(key)
  yield* Effect.gen(function* () {
    const info = (yield* input.runtime.job.wait({ id: childID })).info
    if (!info || info.status === "running") return
    const text =
      info.status === "completed"
        ? (info.output ?? NO_TEXT)
        : info.status === "error"
          ? (info.error ?? "Subagent failed")
          : "Subagent cancelled"
    yield* input.runtime.session.synthetic({
      ...(info.notificationID ? { id: info.notificationID } : {}),
      sessionID: input.parentID,
      text: `<subagent sessionID="${childID}" state="${info.status}" description="${input.title}">\n${text}\n</subagent>`,
      description: input.title,
      metadata: { source: "subagent", ...input.metadata, childID, agent: input.agent.name, state: info.status },
    })
    if (info.notificationID) yield* input.runtime.job.completeBackground(info.notificationID)
  }).pipe(
    Effect.ensuring(Effect.sync(() => notifications.delete(key))),
    Effect.forkIn(input.scope, { startImmediately: true }),
  )
})
