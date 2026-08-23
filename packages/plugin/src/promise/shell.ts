import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

/**
 * Payload for the `shell.sandbox` hook. Hooks receive a copy of the pending invocation and may
 * rewrite `command` and `env`; the rewritten command is what the shell process actually runs,
 * while shell info, events, and permission review keep reporting the original command.
 */
export interface ShellSandbox {
  command: string
  env: Record<string, string | undefined>
  readonly cwd: string
  readonly timeout: number
  readonly shell: string
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
  readonly sandbox: ShellSandbox
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
