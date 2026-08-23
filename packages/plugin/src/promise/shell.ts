import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  command: string
  /**
   * Sandbox form of `command` that is actually passed to the shell process. Permission review
   * and shell info/events keep reporting `command`.
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
