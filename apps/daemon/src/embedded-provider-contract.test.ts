import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { requireTestedVersion, type TestedVersion } from "./embedded-version.js"
import { domovoiKiloConfig, kiloBuiltInPermissions, kiloBuiltInToolIds, testedKilo } from "./kilo-runtime.js"
import { domovoiOpenCodeConfig, openCodeBuiltInPermissions, openCodeBuiltInToolIds, testedOpenCode } from "./opencode.js"

// Security review round 4 of #687 (P2): the adapter trusts permission names
// and tool ids read from particular OpenCode and Kilo releases. This contract
// runs the installed executables, each under a scratch home with only PATH
// from this environment, and fails when the version leaves the tested minor
// line, when the server registers a tool the lists do not hold or drops one,
// or when an agent's merged rules name a permission the lists do not hold.
// It runs only with DOMOVOI_LIVE_PROVIDERS=1, and skips an executable that is
// not on PATH.
const live = process.env.DOMOVOI_LIVE_PROVIDERS === "1"

const providers = [
  { tested: testedOpenCode, config: domovoiOpenCodeConfig, toolIds: openCodeBuiltInToolIds, permissions: openCodeBuiltInPermissions, prefix: "OPENCODE" },
  { tested: testedKilo, config: domovoiKiloConfig, toolIds: kiloBuiltInToolIds, permissions: kiloBuiltInPermissions, prefix: "KILO" },
] as const

const scratch: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM")
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratchEnvironment(prefix: string, config: unknown): Promise<{ env: Record<string, string>; project: string; password: string }> {
  const root = await mkdtemp(join(tmpdir(), "domovoi-embedded-contract-"))
  scratch.push(root)
  const home = join(root, "home")
  const xdg = {
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
  }
  for (const dir of Object.values(xdg)) await mkdir(dir, { recursive: true })
  const project = join(root, "project")
  await mkdir(project)
  const password = "contract-password"
  return {
    env: {
      PATH: process.env.PATH ?? "", HOME: home, ...xdg,
      [`${prefix}_DISABLE_PROJECT_CONFIG`]: "1",
      [`${prefix}_SERVER_PASSWORD`]: password,
      [`${prefix}_SERVER_USERNAME`]: "contract",
      [`${prefix}_CONFIG_CONTENT`]: JSON.stringify(config),
    },
    project,
    password,
  }
}

async function onPath(command: string, env: Record<string, string>): Promise<boolean> {
  try {
    await promisify(execFile)(command, ["--version"], { env, timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!live)("embedded OpenCode and Kilo contract", () => {
  it.for(providers)("$tested.providerName keeps the version, tool ids and permission names the adapter trusts", { timeout: 120_000 }, async ({ tested, config, toolIds, permissions, prefix }, context) => {
    const { env, project, password } = await scratchEnvironment(prefix, config)
    if (!await onPath(tested.command, env)) context.skip(`${tested.command} is not on PATH`)
    const read = async (command: string) => (await promisify(execFile)(command, ["--version"], { env, timeout: 10_000 })).stdout
    expect(tested.tested).toContain(await requireTestedVersion(tested as TestedVersion, read))

    const child = spawn(tested.command, ["serve", "--hostname=127.0.0.1", "--port=0"], { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] })
    children.push(child)
    const url = await new Promise<string>((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error(`no listen line: ${output}`)), 60_000)
      const take = (chunk: Buffer) => {
        output += chunk.toString()
        const match = /listening on\s+(https?:\/\/\S+)/u.exec(output)
        if (match) {
          clearTimeout(timer)
          resolve(match[1]!)
        }
      }
      child.stdout?.on("data", take)
      child.stderr?.on("data", take)
      child.on("exit", (code) => reject(new Error(`exited ${String(code)}: ${output}`)))
    })
    const headers = { authorization: `Basic ${Buffer.from(`contract:${password}`).toString("base64")}` }
    const get = async (path: string) => {
      const response = await fetch(`${url}${path}?directory=${encodeURIComponent(project)}`, { headers })
      expect(response.ok, path).toBe(true)
      return response.json() as Promise<unknown>
    }

    const ids = await get("/experimental/tool/ids") as string[]
    expect([...ids].sort()).toEqual([...toolIds].sort())

    const agents = await get("/agent") as Array<{ name: string; permission: Array<{ permission: string }> }>
    const named = new Set(agents.flatMap((agent) => agent.permission.map((rule) => rule.permission)).filter((permission) => !/[*?]/u.test(permission)))
    expect([...named].filter((permission) => !permissions.has(permission)).sort()).toEqual([])
  })
})
