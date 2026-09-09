import eslint from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

import { typeFloorRules } from "./eslint.type-floor.generated.mjs"

const sourceFiles = ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]
const reactFiles = [
  "apps/desktop/**/*.tsx",
  "apps/web/**/*.tsx",
  "packages/ui/**/*.tsx",
]

export default tseslint.config(
  {
    ignores: ["**/coverage/**", "**/dist/**", "**/out/**"],
  },
  {
    ...eslint.configs.recommended,
    files: sourceFiles,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: sourceFiles,
  })),
  {
    files: sourceFiles,
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Scoped to packages/ui, which is the surface the floor was swept in.
    // apps/mobile has eight of its own and is a separate pass, because it
    // renders through nativewind against generated tokens rather than these
    // utilities. Widening this glob is what makes that pass land.
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      // Generated from the design system, never hand-edited. See scripts/design-rule.mjs.
      "no-restricted-syntax": ["error", ...typeFloorRules],
    },
  },
  {
    files: reactFiles,
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
)
