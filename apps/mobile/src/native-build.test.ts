import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, it } from "vitest"

import appConfig from "../app.config"

// The precompiled Expo modules ship Swift binaries built by one compiler. A newer Xcode
// refuses them (Xcode 27.1, Swift 6.4, refuses SDK 57's Swift 6.3.1 ExpoModulesCore), so
// the app builds Expo modules from source with whatever Xcode is installed. Expo's
// generated Podfile reads the choice from Podfile.properties.json.
it("writes the Podfile property that builds Expo modules from source", async () => {
  expect(appConfig.plugins).toContain("./plugins/with-source-built-expo-modules.js")

  type Mod = (config: Record<string, unknown>) => Promise<{ modResults: Record<string, string> }>
  const plugin = createRequire(__filename)("../plugins/with-source-built-expo-modules.js") as (
    config: Record<string, unknown>,
  ) => { mods: { ios: { podfileProperties: Mod } } }
  const config = plugin({ name: "Domovoi", slug: "domovoi" })
  // A fresh prebuild starts from the template's properties, not from an existing ios/.
  const result = await config.mods.ios.podfileProperties({
    ...config,
    modResults: { "expo.jsEngine": "hermes" },
    modRequest: { projectRoot: join(__dirname, ".."), platform: "ios", modName: "podfileProperties" },
  })
  expect(result.modResults).toEqual({ "expo.jsEngine": "hermes", EXPO_USE_PRECOMPILED_MODULES: "false" })
})
