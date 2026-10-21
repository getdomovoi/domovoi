---
"@getdomovoi/mobile": patch
---

Build the iPhone app with Xcode 27.1 and from `xcodebuild`.

Xcode 27.1 (Swift 6.4) broke local iOS builds in two ways. Expo SDK 57's precompiled
`ExpoModulesCore` was built with Swift 6.3.1, which Swift 6.4 refuses, so a config plugin now sets
`EXPO_USE_PRECOMPILED_MODULES` to `false` and Expo modules build from source with the installed
Xcode. `expo-modules-jsi` 57.1.0 strips C++-only declarations from its generated module interface
by matching `extension __ObjC.`, which misses the `extension __ObjC::` spelling Swift 6.4 writes,
so a pnpm patch carries the strip program from `expo-modules-jsi` 58, which matches both.

A Release build started from `xcodebuild` or the Xcode app also failed to bundle the JavaScript
with `Cannot find module 'babel-preset-expo'`: pnpm's bin shims put its hoisted packages on
`NODE_PATH` and Xcode's bundle phase does not run through them. A config plugin adds the same
directory to `NODE_PATH` in `ios/.xcode.env`.
