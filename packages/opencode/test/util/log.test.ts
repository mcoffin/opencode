import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { afterEach, describe, expect, test } from "bun:test"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) =>
      fs.rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  )
})

function run(dir: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", "./src/index.ts", "db", "path"], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(dir, "share"),
        XDG_CACHE_HOME: path.join(dir, "cache"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_STATE_HOME: path.join(dir, "state"),
        OPENCODE_MODELS_PATH: path.join(import.meta.dir, "..", "fixture", "tool", "fixtures", "models-api.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => {
      out += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      err += chunk.toString()
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, out, err }))
  })
}

describe("util.log", () => {
  test("creates a log file for one-shot cli commands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-"))
    dirs.push(dir)

    const out = await run(dir)
    expect(out.code).toBe(0)

    const log = path.join(dir, "share", "opencode", "log")
    const files = (await fs.readdir(log)).filter((item) => item.endsWith(".log"))
    expect(files.length).toBeGreaterThan(0)

    const text = await fs.readFile(path.join(log, files[0]), "utf8")
    expect(text).toContain("service=default")
    expect(text).toContain('args=["db","path"]')
  })
})
