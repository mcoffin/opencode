import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ListTool } from "./ls"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"

export namespace ToolRegistry {
  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("tool/*.{js,ts}")

    for (const dir of await Config.directories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        const mod = await import(match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async () => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const result = await def.execute(args as any, ctx)
          return {
            title: "",
            output: result,
            metadata: {},
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    return [
      InvalidTool,
      BashTool,
      EditTool,
      WebFetchTool,
      GlobTool,
      GrepTool,
      ListTool,
      ReadTool,
      WriteTool,
      TodoWriteTool,
      TodoReadTool,
      TaskTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_EXA ? [WebSearchTool, CodeSearchTool] : []),
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(_providerID: string, _modelID: string) {
    const tools = await all()
    const result = await Promise.all(
      tools.map(async (t) => ({
        id: t.id,
        ...(await t.init()),
      })),
    )
    return result
  }

  export async function enabled(
    _providerID: string,
    _modelID: string,
    agent: Agent.Info,
  ): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {}

    // Get all tool IDs
    const toolIds = await ids()

    // Check each tool's permission using the generic permission system
    const { Permission } = await import("../permission")
    for (const toolId of toolIds) {
      const permission = Permission.getToolPermission(toolId, agent.permission)
      if (permission === "deny") {
        result[toolId] = false
      }
    }

    // Special case: if edit is denied, also deny write
    if (Permission.getToolPermission("edit", agent.permission) === "deny") {
      result["write"] = false
    }

    // Keep legacy bash permission check (has granular command-level permissions)
    if (agent.permission.bash["*"] === "deny" && Object.keys(agent.permission.bash).length === 1) {
      result["bash"] = false
    }

    return result
  }
}
