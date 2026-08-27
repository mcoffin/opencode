import type { Agent } from "@opencode-ai/schema/agent"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Tool } from "@opencode-ai/schema/tool"
import type { Hooks } from "./registration.js"

/**
 * Provenance of a shell command. `user` commands are run by the user in a session
 * (for example the TUI shell prompt); `tool` commands are model-initiated shell tool calls and
 * carry the full call identity for correlation with session history; `api` commands are created
 * through the shell API or a direct `Shell.create` call that declares no source.
 */
export type ShellSource =
  | { readonly type: "user"; readonly sessionID: Session.ID }
  | {
      readonly type: "tool"
      readonly sessionID: Session.ID
      readonly agent: Agent.ID
      readonly messageID: SessionMessage.ID
      readonly toolCallID: Tool.CallID
    }
  | { readonly type: "api" }

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
  readonly source: ShellSource
}

/**
 * Payload for the `shell.sandbox` hook. Hooks receive a copy of the pending invocation and may
 * rewrite `command` and `env`; the rewritten command is what the shell process actually runs,
 * while shell info, events, and permission review keep reporting the original command.
 * `source` identifies where the command came from.
 */
export interface ShellSandbox {
  command: string
  env: Record<string, string | undefined>
  readonly cwd: string
  readonly timeout: number
  readonly shell: string
  readonly source: ShellSource
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
  readonly sandbox: ShellSandbox
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
