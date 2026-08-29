export * as ConfigCommandPlugin from "./command.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Info, type Entry } from "@opencode-ai/schema/config"
import { ConfigCommand } from "@opencode-ai/schema/config/command"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import { AppProcess } from "@opencode-ai/util/process"
import path from "path"
import { Effect, Option, Schema, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { SessionEvent } from "../../session/event.js"
import type { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { ShellSelect } from "../../shell/select.js"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { ConfigMarkdown } from "../markdown.js"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

const NO_TEXT = "Subagent completed without a text response."

export const Plugin = define({
  id: "opencode.config.command",
  effect: Effect.fn(function* (ctx) {
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const runtime = yield* PluginRuntime.Service
    const scope = yield* Scope.Scope
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [{ commands: entry.info.commands }]
      if (entry.type !== "directory") return []
      const commands = yield* loadDirectory(fs, entry.path)
      return [{ commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) }]
    })
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    const shell = yield* ShellSelect.Service
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as { commands: Info["commands"] }[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.command.reload()),
    )
    // One merged trigger stream serializes reloads and shares one debounce
    // window; subscribing before the initial scan means updates racing the
    // scan still trigger a rebuild.
    const sourceChanges = config
      .changes()
      .pipe(
        Stream.filterEffect((update) =>
          Effect.map(config.entries(), (entries) => isCommandSource(entries, update.path)),
        ),
      )
    const configUpdates = ctx.event.subscribe().pipe(Stream.filter((event) => event.type === "config.updated"))
    yield* Stream.merge(sourceChanges, configUpdates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("ConfigCommandPlugin.latestAssistantText")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const messages = yield* runtime.session.messages({ sessionID, order: "desc", limit: 20 })
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })
    const runSubtask = Effect.fn("ConfigCommandPlugin.runSubtask")(function* (input: {
      readonly parent: SessionSchema.Info
      readonly childAgent: Agent.Info
      readonly title: string
      readonly command: string
      readonly model?: Model.Ref
      readonly text: string
      readonly prompt: PromptInput.Prompt
    }) {
      // The caller's Session keeps its own agent and model; only the child adopts them.
      const child = yield* runtime.session.create({
        parentID: input.parent.id,
        title: input.title,
        agent: input.childAgent.id,
        model: input.model ?? input.parent.model,
      })
      // Standard prompt admission outside the job: Job.start joining a running child skips
      // its run effect, and the default wake starts an idle child or steers a running one.
      yield* runtime.session.prompt({
        sessionID: child.id,
        text: input.text,
        ...(input.prompt.files === undefined ? {} : { files: input.prompt.files }),
        ...(input.prompt.agents === undefined ? {} : { agents: input.prompt.agents }),
        ...(input.prompt.skills === undefined ? {} : { skills: input.prompt.skills }),
        resume: false,
      })
      const recovery = {
        kind: "subagent" as const,
        parentSessionID: input.parent.id,
        childSessionID: child.id,
        agent: input.childAgent.name,
        description: input.title,
      }
      const info = yield* runtime.job.start({
        id: child.id,
        type: "subagent",
        title: input.title,
        metadata: { command: input.command },
        recovery,
        run: runtime.session.resume(child.id).pipe(Effect.andThen(latestAssistantText(child.id))),
      })
      yield* runtime.job.background(info.id)
      // One completion observer; command subtasks always create a fresh child, so no dedup key.
      yield* Effect.gen(function* () {
        const result = yield* runtime.job.wait({ id: child.id })
        if (result.info) yield* SubagentCompletion.deliver(runtime.session, runtime.job, { ...result.info, recovery })
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      // Commit a launch notice to the caller's conversation so the subtask is visible before
      // it settles. Published directly rather than through Session.synthetic: the caller must
      // not be woken, only informed when the child completes (the observer adds that notice).
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID: input.parent.id,
        text: `<subagent sessionID="${child.id}" state="running" description="${input.title}"></subagent>`,
        description: input.title,
        metadata: {
          source: "subagent",
          command: input.command,
          childID: child.id,
          agent: input.childAgent.name,
          state: "running",
        },
      })
      return child
    })
    yield* ctx.command.transform((draft) => {
      for (const document of loaded.documents) {
        for (const [name, command] of Object.entries(document.commands ?? {})) {
          draft.add({
            name,
            description: command.description,
            execute: (input) =>
              Effect.gen(function* () {
                const requested = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
                const commandAgent = requested === undefined ? undefined : yield* agents.get(requested)
                // An explicitly configured agent that no longer exists must not silently fall back
                // to the caller's agent, in a child or in the caller's own Session.
                if (requested !== undefined && commandAgent === undefined)
                  return yield* Effect.fail(new Error(`Command ${name} references unknown agent ${requested}`))
                const model =
                  command.model === undefined
                    ? commandAgent?.model
                    : {
                        id: Model.ID.make(command.model.model),
                        providerID: Provider.ID.make(command.model.providerID),
                        ...(command.model.variant === undefined
                          ? {}
                          : { variant: Model.VariantID.make(command.model.variant) }),
                      }
                const text = yield* evaluateTemplate(command.template, input.prompt.text, {
                  location,
                  processes,
                  shell,
                })
                // V1 parity: a subagent-mode agent runs the command in a child Session unless the
                // command opts out, and `subtask: true` forces one even for a primary agent.
                if ((commandAgent?.mode === "subagent" && command.subtask !== false) || command.subtask === true) {
                  const parent = yield* runtime.session.get(input.sessionID)
                  // No command agent falls back to the caller's current agent.
                  const childAgent = commandAgent ?? (yield* agents.resolve(parent.agent))
                  if (childAgent === undefined)
                    return yield* Effect.fail(new Error(`Command ${name} could not resolve a subtask agent`))
                  yield* runSubtask({
                    parent,
                    childAgent,
                    title: command.description ?? name,
                    command: name,
                    model,
                    text,
                    prompt: input.prompt,
                  })
                  return
                }
                if (requested !== undefined) {
                  const session = yield* ctx.session.get({ sessionID: input.sessionID })
                  if (session.agent !== requested)
                    yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent: requested })
                }
                if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
                yield* ctx.session.prompt({
                  ...input.prompt,
                  sessionID: input.sessionID,
                  text,
                  delivery: input.delivery,
                })
              }).pipe(Effect.asVoid),
          })
        }
      }
    })
  }),
})

// Keep in sync with the loadDirectory scan pattern and the name-strip regex in decode.
const sourceDirectories = ["command", "commands"] as const

// Matches anything at or under <root>/{command,commands}. No file-suffix check:
// directory-level events such as renames carry no per-file paths.
function isCommandSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.orElseSucceed(() => [] as string[]))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}

function evaluateTemplate(
  template: string,
  input: string,
  services: {
    readonly location: Location.Info
    readonly processes: AppProcess.Interface
    readonly shell: ShellSelect.Interface
  },
) {
  return Effect.gen(function* () {
    const args = parseArguments(input)
    const placeholders = template.match(placeholderRegex) ?? []
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    const expanded = template.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const withArguments = expanded.replaceAll("$ARGUMENTS", input)
    const text =
      placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
        ? `${withArguments}\n\n${input}`.trim()
        : withArguments.trim()
    const matches = Array.from(text.matchAll(shellRegex))
    if (matches.length === 0) return text
    const shell = yield* services.shell.resolve({ priority: "config" })
    const outputs = yield* Effect.forEach(
      matches,
      (match) => {
        const source = match[1] ?? ""
        return services.processes
          .run(
            ChildProcess.make(shell, ShellSelect.args(shell, source), {
              cwd: services.location.directory,
              stdin: "ignore",
            }),
            { combineOutput: true },
          )
          .pipe(
            Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
            Effect.mapError((error) =>
              new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${error.message}`),
            ),
          )
      },
      { concurrency: 2 },
    )
    const iterator = outputs[Symbol.iterator]()
    return text.replace(shellRegex, () => iterator.next().value ?? "")
  })
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g
