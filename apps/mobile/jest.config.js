// Screens are drawn here, under React Native's own component tree, so a test
// reads what a person would see. The logic tests stay under vitest, which owns
// every .test.ts file; this runner picks up only .test.tsx, so the two never
// collect the same file. jest-expo 57 already excludes pnpm's node_modules/.pnpm
// layout from transformIgnorePatterns, which is what let React Native's own
// modules go untransformed in earlier attempts.
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.tsx"],
}
