// Screens are drawn here, under React Native's own component tree, so a test
// reads what a person would see. The logic tests stay under vitest, which owns
// every .test.ts file; this runner picks up only .test.tsx, so the two never
// collect the same file. jest-expo 57 already excludes pnpm's node_modules/.pnpm
// layout from transformIgnorePatterns, which is what let React Native's own
// modules go untransformed in earlier attempts.
const expoPreset = require("jest-expo/jest-preset")

module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.tsx"],
  // Exercise noble's real ESM modules through the phone's Babel transform.
  // Preserve Expo's exclusions for transformer plugins and presets.
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.replace("(.pnpm|", "(@noble/|.pnpm|")),
}
