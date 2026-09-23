import { defineConfig, mergeConfig } from "vitest/config"
import base from "../vitest.config.js"

export default mergeConfig(base, defineConfig({
  test: {
    root: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    setupFiles: [new URL("./timing-setup.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  },
}))
