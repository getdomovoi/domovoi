import { describe, expect, it } from "vitest"

import { vendorChunkFor } from "./vite-chunks"

describe("vendorChunkFor", () => {
  it.each([
    ["/repo/node_modules/.pnpm/react-dom@19/node_modules/react-dom/client.js", "react"],
    ["/repo/node_modules/.pnpm/radix-ui@1/node_modules/radix-ui/dist/index.mjs", "ui"],
    ["/repo/node_modules/.pnpm/@radix-ui+react-dialog@1/node_modules/@radix-ui/react-dialog/dist/index.mjs", "ui"],
    ["/repo/node_modules/.pnpm/lucide-react@1/node_modules/lucide-react/dist/cjs.js", "icons"],
    ["C:\\repo\\node_modules\\react-resizable-panels\\dist\\index.js", "panels"],
    ["/repo/node_modules/zod/index.js", "validation"],
  ])("maps %s to %s", (moduleId, chunk) => {
    expect(vendorChunkFor(moduleId)).toBe(chunk)
  })

  it("keeps application modules in their entry chunk", () => {
    expect(vendorChunkFor("/repo/packages/ui/src/workspace-shell.tsx")).toBeUndefined()
  })
})
