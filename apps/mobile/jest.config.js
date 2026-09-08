const preset = require("jest-expo/jest-preset")

// jest-expo transforms only the packages its own pattern names, and the pattern
// matches any node_modules segment rather than the last one, so a package
// linked under pnpm's store is still ignored by the name it is linked as.
// Amending jest-expo's pattern rather than replacing it keeps the rest of its
// list current when jest-expo changes it, and the guard turns a pattern this no
// longer recognises into a failure rather than a module that quietly does not
// compile.
const marker = "(?!(.pnpm|"
const transformed = ["@noble/", "lucide-react-native", "react-native-svg"]
const transformIgnorePatterns = preset.transformIgnorePatterns.map((pattern) =>
  pattern.includes(marker)
    ? pattern.replace(marker, `${marker}${transformed.join("|")}|`)
    : pattern,
)
if (!transformIgnorePatterns.some((pattern) => pattern.includes(transformed[0]))) {
  throw new Error("jest-expo no longer names the pattern that lists transformable packages")
}

// Screens are drawn here, under React Native's own component tree, so a test
// reads what a person would see. The logic tests stay under vitest, which owns
// every .test.ts file; this runner picks up only .test.tsx, so the two never
// collect the same file.
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.tsx"],
  // Lucide ships one .mjs module per icon, an extension jest-expo's transform
  // does not match, so the same babel step is pointed at it.
  transform: { ...preset.transform, "\\.mjs$": preset.transform["\\.[jt]sx?$"] },
  transformIgnorePatterns,
}
