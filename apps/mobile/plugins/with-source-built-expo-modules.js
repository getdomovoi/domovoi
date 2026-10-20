const { withPodfileProperties } = require("expo/config-plugins")

// The Podfile Expo generates sets EXPO_USE_PRECOMPILED_MODULES=1 unless
// Podfile.properties.json says "false". Precompiled Expo modules are Swift
// binaries built by one compiler, and a newer Xcode refuses them: Xcode 27.1
// (Swift 6.4) refuses SDK 57's ExpoModulesCore, built with Swift 6.3.1. Built
// from source, the modules compile with whatever Xcode builds the app, so a
// local build survives an Xcode update. The cost is a longer first build.
module.exports = function withSourceBuiltExpoModules(config) {
  return withPodfileProperties(config, (config) => {
    config.modResults.EXPO_USE_PRECOMPILED_MODULES = "false"
    return config
  })
}
