import eslint from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

import { phoneTypeFloorRules, typeFloorRules } from "./eslint.type-floor.generated.mjs"

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
    // apps/mobile is a separate block below rather than a wider glob here. It
    // renders through nativewind against a different ramp, and its floor is
    // higher than this one, so one rule cannot serve both.
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      // Generated from the design system, never hand-edited. scripts/design-rule.mjs
      // derives the boundary from design/design_system_domovoi/_adherence.oxlintrc.json
      // and tokens/typography.css, and pnpm design:rule regenerates it.
      //
      // That vendored file is an oxlint config, and nothing runs it. This repository
      // does not install oxlint; it is vendored as data for its x-omelette.tokenKinds
      // manifest. Its own rules are all warnings, and its raw-pixel selector matches
      // the 5px inside 9.5px, so enabling them would flag the values the design system
      // defines.
      "no-restricted-syntax": ["error", ...typeFloorRules],
    },
  },
  {
    // The phone's floor is 10px and the desktop's boundary is 9.5px, so this is
    // its own block with its own generated rule. Both are derived: the desktop's
    // from the design system's typography tokens, the phone's from the
    // --text-phone-* ramp in packages/ui/src/styles.css. They describe different
    // scales rather than one restating the other.
    files: ["apps/mobile/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...phoneTypeFloorRules],
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
