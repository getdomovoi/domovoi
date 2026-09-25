import { describe, expect, it } from "vitest"

import config from "./electron.vite.config.js"

describe("Electron Vite development server", () => {
  it("uses the fixed loopback origin admitted by a separately started local daemon", () => {
    expect(typeof config).toBe("object")
    if (typeof config !== "object") throw new Error("Expected a static Electron Vite configuration")
    expect(config.renderer?.server).toMatchObject({ port: 5178, strictPort: true })
  })
})
