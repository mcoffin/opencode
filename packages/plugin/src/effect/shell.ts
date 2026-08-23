import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  command: string
  /**
   * Command actually passed to the shell process. When set, `command` remains
   * the user-visible value in shell info and events.
   */
  execution_command?: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
