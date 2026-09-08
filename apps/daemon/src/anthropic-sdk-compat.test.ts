import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { runInNewContext } from "node:vm"

import Anthropic, { APIConnectionTimeoutError } from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

type SdkErrors = {
  castToError(error: unknown): Error
  isAbortError(error: unknown): boolean
}

describe("Anthropic SDK compatibility", () => {
  it.each([
    ["AbortError", "This operation was aborted"],
    ["TimeoutError", "The operation timed out"],
  ])("preserves a native %s across JavaScript realms", (name, message) => {
    const raw = new DOMException(message, name)
    const entryPath = createRequire(import.meta.url).resolve("@anthropic-ai/sdk")
    const modulePath = join(dirname(entryPath), "internal/errors.js")
    const scope = { exports: {} as SdkErrors, raw }
    // Execute the installed SDK module in another realm. The exception is a
    // real Node DOMException, not a mock with a forged name or toStringTag.
    runInNewContext(readFileSync(modulePath, "utf8"), scope, { filename: modulePath, timeout: 1_000 })
    expect(runInNewContext("raw instanceof Error", scope)).toBe(false)
    const classified = scope.exports.castToError(raw)
    expect(classified.name).toBe(name)
    expect(classified.message).toBe(message)
    expect(scope.exports.isAbortError(classified)).toBe(name === "AbortError")
  })

  it("reports a fetch timeout through the public SDK without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new DOMException("The operation timed out", "TimeoutError")
    })
    const client = new Anthropic({ apiKey: "test-sdk-credential", fetch, maxRetries: 0 })
    await expect(client.messages.create({
      model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "test" }],
    })).rejects.toBeInstanceOf(APIConnectionTimeoutError)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
