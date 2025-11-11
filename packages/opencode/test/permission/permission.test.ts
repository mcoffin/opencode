import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import { ToolRegistry } from "../../src/tool/registry"

describe("Permission System", () => {
  describe("checkTool", () => {
    test("throws RejectedError when permission is deny", async () => {
      const agentPermission = {
        tools: {
          test_tool: "deny" as const,
        },
      }

      await expect(
        Permission.checkTool({
          toolId: "test_tool",
          sessionID: "test-session",
          messageID: "test-message",
          callID: "test-call",
          agentPermission,
          metadata: {},
        }),
      ).rejects.toThrow(Permission.RejectedError)
    })

    test("does not throw when permission is allow", async () => {
      const agentPermission = {
        tools: {
          test_tool: "allow" as const,
        },
      }

      await expect(
        Permission.checkTool({
          toolId: "test_tool",
          sessionID: "test-session",
          messageID: "test-message",
          callID: "test-call",
          agentPermission,
          metadata: {},
        }),
      ).resolves.toBeUndefined()
    })

    test("uses custom title when provided", async () => {
      const agentPermission = {
        tools: {
          test_tool: "allow" as const,
        },
      }

      await expect(
        Permission.checkTool({
          toolId: "test_tool",
          sessionID: "test-session",
          messageID: "test-message",
          callID: "test-call",
          agentPermission,
          title: "Custom title for test_tool",
          metadata: {},
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe("getToolPermission", () => {
    test("returns specific tool permission from tools map", () => {
      const permission = Permission.getToolPermission("grep", {
        tools: {
          grep: "deny",
          "*": "allow",
        },
      })
      expect(permission).toBe("deny")
    })

    test("falls back to wildcard when specific tool not found", () => {
      const permission = Permission.getToolPermission("grep", {
        tools: {
          "*": "ask",
        },
      })
      expect(permission).toBe("ask")
    })

    test("uses legacy edit field for backwards compatibility", () => {
      const permission = Permission.getToolPermission("edit", {
        edit: "ask",
      })
      expect(permission).toBe("ask")
    })

    test("uses legacy edit field for write tool", () => {
      const permission = Permission.getToolPermission("write", {
        edit: "deny",
      })
      expect(permission).toBe("deny")
    })

    test("uses legacy webfetch field for backwards compatibility", () => {
      const permission = Permission.getToolPermission("webfetch", {
        webfetch: "ask",
      })
      expect(permission).toBe("ask")
    })

    test("uses legacy bash field (string form) for backwards compatibility", () => {
      const permission = Permission.getToolPermission("bash", {
        bash: "deny",
      })
      expect(permission).toBe("deny")
    })

    test("uses legacy bash field (map form) for backwards compatibility", () => {
      const permission = Permission.getToolPermission("bash", {
        bash: {
          "*": "ask",
        },
      })
      expect(permission).toBe("ask")
    })

    test("tools map takes precedence over legacy fields", () => {
      const permission = Permission.getToolPermission("edit", {
        edit: "allow",
        tools: {
          edit: "ask",
        },
      })
      expect(permission).toBe("ask")
    })

    test("specific tool in tools map takes precedence over wildcard", () => {
      const permission = Permission.getToolPermission("grep", {
        tools: {
          "*": "allow",
          grep: "deny",
        },
      })
      expect(permission).toBe("deny")
    })

    test("defaults to ask for unknown tools", () => {
      const permission = Permission.getToolPermission("unknown_tool", {})
      expect(permission).toBe("ask")
    })
  })

  describe("Backwards Compatibility", () => {
    test("config with legacy edit permission works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                edit: "ask",
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.permission?.edit).toBe("ask")

          // Verify it works with Agent system
          const agent = await Agent.get("general")
          const permission = Permission.getToolPermission("edit", agent.permission)
          expect(permission).toBe("ask")
        },
      })
    })

    test("config with legacy bash permission works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                bash: {
                  "git *": "allow",
                  "*": "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.permission?.bash).toEqual({
            "git *": "allow",
            "*": "deny",
          })
        },
      })
    })

    test("config with legacy webfetch permission works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                webfetch: "ask",
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.permission?.webfetch).toBe("ask")

          const agent = await Agent.get("general")
          const permission = Permission.getToolPermission("webfetch", agent.permission)
          expect(permission).toBe("ask")
        },
      })
    })
  })

  describe("New Tools Map", () => {
    test("config with tools map for grep works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  grep: "ask",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.permission?.tools?.grep).toBe("ask")

          const agent = await Agent.get("general")
          const permission = Permission.getToolPermission("grep", agent.permission)
          expect(permission).toBe("ask")
        },
      })
    })

    test("config with tools map for multiple tools works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  grep: "ask",
                  glob: "deny",
                  read: "allow",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.permission?.tools?.grep).toBe("ask")
          expect(config.permission?.tools?.glob).toBe("deny")
          expect(config.permission?.tools?.read).toBe("allow")
        },
      })
    })
  })

  describe("Wildcard Permissions", () => {
    test("wildcard ask prompts for all tools", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  "*": "ask",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")

          // Check various tools - should all be "ask"
          for (const name in ["grep", "glob", "read", "write", "edit"]) {
            expect(Permission.getToolPermission(name, agent.permission)).toBe("ask")
          }
        },
      })
    })

    test("specific tool permission overrides wildcard", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  "*": "deny",
                  grep: "allow",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")

          // grep should be allowed, others denied
          expect(Permission.getToolPermission("grep", agent.permission)).toBe("allow")
          expect(Permission.getToolPermission("glob", agent.permission)).toBe("deny")
          expect(Permission.getToolPermission("read", agent.permission)).toBe("deny")
        },
      })
    })
  })

  describe("Precedence Rules", () => {
    test("tools map takes precedence over legacy edit field", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                edit: "allow",
                tools: {
                  edit: "ask",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          const permission = Permission.getToolPermission("edit", agent.permission)
          expect(permission).toBe("ask")
        },
      })
    })

    test("tools map takes precedence over legacy webfetch field", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                webfetch: "allow",
                tools: {
                  webfetch: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          const permission = Permission.getToolPermission("webfetch", agent.permission)
          expect(permission).toBe("deny")
        },
      })
    })

    test("specific tool in tools map takes precedence over wildcard", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  "*": "allow",
                  grep: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          expect(Permission.getToolPermission("grep", agent.permission)).toBe("deny")
          expect(Permission.getToolPermission("glob", agent.permission)).toBe("allow")
        },
      })
    })
  })

  describe("Tool Registry Integration", () => {
    test("deny permission disables tool in registry", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  glob: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          const enabledTools = await ToolRegistry.enabled("test", "test", agent)

          // glob should be disabled
          expect(enabledTools["glob"]).toBe(false)
        },
      })
    })

    test("deny edit also denies write", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  edit: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          const enabledTools = await ToolRegistry.enabled("test", "test", agent)

          // both edit and write should be disabled
          expect(enabledTools["edit"]).toBe(false)
          expect(enabledTools["write"]).toBe(false)
        },
      })
    })

    test("global bash deny disables bash tool", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  bash: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")
          const enabledTools = await ToolRegistry.enabled("test", "test", agent)

          // bash should be disabled
          expect(enabledTools["bash"]).toBe(false)
        },
      })
    })
  })

  describe("Agent-Specific Permissions", () => {
    test("agent can override global permissions", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                tools: {
                  grep: "deny",
                },
              },
              agent: {
                custom: {
                  description: "Custom agent with grep allowed",
                  permission: {
                    tools: {
                      grep: "allow",
                    },
                  },
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // General agent should have grep denied
          const generalAgent = await Agent.get("general")
          expect(Permission.getToolPermission("grep", generalAgent.permission)).toBe("deny")

          // Custom agent should have grep allowed
          const customAgent = await Agent.get("custom")
          expect(Permission.getToolPermission("grep", customAgent.permission)).toBe("allow")
        },
      })
    })
  })

  describe("Migration from Legacy Fields", () => {
    test("merges legacy edit into tools map", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                edit: "ask",
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")

          // Legacy edit field should be migrated to tools map
          expect(agent.permission.tools?.edit).toBe("ask")
          expect(agent.permission.tools?.write).toBe("ask")
        },
      })
    })

    test("merges legacy webfetch into tools map", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                webfetch: "deny",
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")

          // Legacy webfetch field should be migrated to tools map
          expect(agent.permission.tools?.webfetch).toBe("deny")
        },
      })
    })

    test("does not override explicit tools map with legacy fields", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              permission: {
                edit: "allow",
                tools: {
                  edit: "deny",
                },
              },
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get("general")

          // Explicit tools map should not be overridden
          expect(agent.permission.tools?.edit).toBe("deny")
        },
      })
    })
  })
})
