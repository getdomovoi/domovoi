import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { expect, it } from "vitest"

// The precompiled Expo modules ship Swift binaries built by one compiler. A newer Xcode
// refuses them (Xcode 27.1, Swift 6.4, refuses SDK 57's Swift 6.3.1 ExpoModulesCore), so
// the app builds Expo modules from source with whatever Xcode is installed.
it("writes the Podfile property that builds Expo modules from source", () => {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["expo", "config", "--type", "introspect", "--json"],
    {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, EXPO_OFFLINE: "1" },
      shell: process.platform === "win32",
    },
  )
  expect(result.status, result.stderr).toBe(0)
  const config = JSON.parse(result.stdout) as {
    _internal?: { modResults?: { ios?: { podfileProperties?: Record<string, string> } } }
  }
  expect(config._internal?.modResults?.ios?.podfileProperties?.EXPO_USE_PRECOMPILED_MODULES).toBe("false")
}, 60_000)
