import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import appConfig from "../app.config"

const appRoot = join(__dirname, "..")

// The probe compiles JSX with this app's babel.config.js the way Metro does in Xcode's
// "Bundle React Native code and images" phase: @babel/core from @expo/metro-config, run by
// plain node with whatever environment the phase sourced from ios/.xcode.env.
const probe = [
  'const { createRequire } = require("node:module")',
  'const path = require("node:path")',
  "const root = process.cwd()",
  'const expoPackage = require.resolve("expo/package.json", { paths: [root] })',
  'const metroConfig = createRequire(expoPackage).resolve("@expo/metro-config/package.json")',
  'const babel = createRequire(metroConfig)("@babel/core")',
  'babel.transformSync("export const A = () => <A />\\n", {',
  '  filename: path.join(root, "probe.tsx"), cwd: root, root,',
  '  caller: { name: "metro", bundler: "metro", platform: "ios", isDev: false },',
  "})",
].join("\n")

describe.skipIf(process.platform === "win32")("Xcode script phase environment", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("lets the bundle phase load the app's Babel presets without pnpm's bin shim", async () => {
    expect(appConfig.plugins).toContain("./plugins/with-pnpm-node-path.js")
    const platformProjectRoot = join(mkdtempSync(join(tmpdir(), "domovoi-xcode-env-")), "ios")
    dirs.push(join(platformProjectRoot, ".."))
    mkdirSync(platformProjectRoot)
    const xcodeEnv = join(platformProjectRoot, ".xcode.env")
    writeFileSync(xcodeEnv, "export NODE_BINARY=$(command -v node)\n")

    type Mod = (config: Record<string, unknown>) => Promise<unknown>
    const plugin = createRequire(__filename)("../plugins/with-pnpm-node-path.js") as (
      config: Record<string, unknown>,
    ) => { mods: { ios: { dangerous: Mod } } }
    const config = plugin({ name: "Domovoi", slug: "domovoi" })
    const apply = () =>
      config.mods.ios.dangerous({
        ...config,
        modRequest: { projectRoot: appRoot, platformProjectRoot, platform: "ios", modName: "dangerous" },
      })
    await apply()
    // A prebuild without --clean applies the plugin again to the same file, which may by then
    // carry lines someone added after the block.
    appendFileSync(xcodeEnv, "export LATER=kept\n")
    await apply()
    const written = readFileSync(xcodeEnv, "utf8")
    expect(written.startsWith("export NODE_BINARY=$(command -v node)\n")).toBe(true)
    expect(written.match(/^export NODE_PATH=/gm)).toHaveLength(1)
    expect(written.endsWith("export LATER=kept\n")).toBe(true)

    const env = { ...process.env }
    delete env.NODE_PATH
    const result = spawnSync("sh", ["-c", '. "$1" && exec "$NODE_BINARY" -e "$2"', "sh", xcodeEnv, probe], {
      cwd: appRoot,
      encoding: "utf8",
      env,
    })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  }, 30_000)
})
