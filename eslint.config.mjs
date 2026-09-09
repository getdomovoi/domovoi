import eslint from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

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
      // The type floor, enforced rather than remembered. Sans prose stops at
      // --text-micro; below it only --text-eyebrow and --text-mono-xs exist,
      // and each has a utility. A raw value under 9.5px has no token behind it
      // at all, which is how forty of them spread by copy-paste.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/text-\\[(?:[0-8](?:\\.\\d+)?|9(?:\\.[0-4]\\d*)?)px\\]/]",
          message: "Text below 9.5px has no token behind it. Use text-eyebrow for an uppercase section label, text-mono-xs for machine output, or text-micro for sans prose.",
        },
        {
          selector: "TemplateElement[value.raw=/text-\\[(?:[0-8](?:\\.\\d+)?|9(?:\\.[0-4]\\d*)?)px\\]/]",
          message: "Text below 9.5px has no token behind it. Use text-eyebrow for an uppercase section label, text-mono-xs for machine output, or text-micro for sans prose.",
        },
      ],
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
