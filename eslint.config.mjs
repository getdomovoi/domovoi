import eslint from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

import { phoneTypeFloorRules, statusDotRules, typeFloorRules } from "./eslint.type-floor.generated.mjs"

const sourceFiles = ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]

// Two rules that each landed twice as a review fix in one week and were
// enforced by nothing. A durable file's bytes are unknown until a schema says
// otherwise (#416, then the auto-update staging slice), and a rename is only
// atomic for readers until the directory is flushed (#409, then the same
// slice). scripts/durability-rules.test.mjs holds the red and green cases.
export const durabilityRules = [
  {
    selector: 'TSAsExpression[typeAnnotation.type!="TSUnknownKeyword"] > CallExpression[callee.object.name="JSON"][callee.property.name="parse"]',
    message: "A JSON.parse result is unknown until a schema decides; a damaged file must refuse, not become trusted state. Parse into unknown and validate.",
  },
]
const durablePublishImport = {
  name: "node:fs/promises",
  importNames: ["rename"],
  allowTypeImports: true,
  message: "A bare rename is atomic for readers and not for power loss. Publish through publishFileDurably from @getdomovoi/credential-store, which flushes the directory too.",
}
// Sites that predate the two rules. This list only shrinks: a site that moves
// onto a schema or onto publishFileDurably is removed here in the same change,
// and nothing is ever added. Tests and fixtures are exempt from the parse rule
// outright; a fixture asserting a shape it wrote is not a trust decision.
const durabilityAllowlist = {
  parse: [
    "apps/daemon/src/cli-rpc.ts",
    "apps/daemon/src/index.ts",
    "apps/daemon/src/local-daemon.ts",
    "apps/daemon/src/providers.ts",
    "apps/daemon/src/server.ts",
    "apps/daemon/src/store.ts",
    "packages/ui/src/workspace-shell.tsx",
  ],
  rename: [
    "apps/daemon/src/endpoint-file.ts",
    "apps/daemon/src/skill-install.ts",
    "apps/daemon/src/skill-signing.ts",
    "apps/daemon/src/transfer-transactions.ts",
  ],
}
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
      "no-restricted-syntax": ["error", ...durabilityRules],
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [durablePublishImport] }],
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
      "no-restricted-syntax": ["error", ...typeFloorRules, ...statusDotRules, ...durabilityRules],
    },
  },
  {
    // StatusDot is the one place the raw dot belongs: styles.css keys its
    // forced-colors override on data-status-dot, and the atom is what every
    // other file is told to use instead. The rule stays on for everything else.
    files: ["packages/ui/src/status-dot.tsx"],
    rules: {
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
      "no-restricted-syntax": ["error", ...phoneTypeFloorRules, ...statusDotRules, ...durabilityRules],
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
  {
    // The helper that owns the durable publish is the one place rename is
    // imported directly. The daemon's service installer keeps its own rename
    // under its install deadline; it publishes a service configuration, not a
    // trust record, and its durability claim is stated in that file.
    files: ["packages/credential-store/src/index.ts", "apps/daemon/src/service/install.ts", ...durabilityAllowlist.rename],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  {
    // Tests, fixtures and the allowlisted sources keep every other syntax rule
    // and drop only the durability one. Each scope restates its own set so the
    // type-floor and StatusDot rules do not go with it.
    files: ["packages/ui/**/*.test.{ts,tsx}", "packages/ui/**/test-support/**", "packages/ui/src/workspace-shell.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...typeFloorRules, ...statusDotRules],
    },
  },
  {
    files: ["apps/mobile/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...phoneTypeFloorRules, ...statusDotRules],
    },
  },
  {
    files: ["apps/!(mobile)/**/*.test.{ts,tsx}", "packages/!(ui)/**/*.test.{ts,tsx}", "**/test-*.ts", "**/*.fixture.ts", ...durabilityAllowlist.parse.filter((file) => !file.startsWith("packages/ui/"))],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
)
