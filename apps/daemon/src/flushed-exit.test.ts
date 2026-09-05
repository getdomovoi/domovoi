import { describe, expect, it, vi } from "vitest"

import { exitAfterStderr } from "./flushed-exit.js"

function target() {
  const callbacks: Array<() => void> = []
  return {
    callbacks,
    stderr: { write: vi.fn((_text: string, callback: () => void) => { callbacks.push(callback) }) },
    exit: vi.fn(),
  }
}

describe("exitAfterStderr", () => {
  it("exits only once stderr has taken the diagnostic", async () => {
    const cli = target()
    const pending = exitAfterStderr("gone\n", 1, 1_000, cli)
    expect(cli.stderr.write).toHaveBeenCalledWith("gone\n", expect.any(Function))
    expect(cli.exit).not.toHaveBeenCalled()
    cli.callbacks[0]!()
    await pending
    expect(cli.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it("exits within its budget when a piped reader never drains", async () => {
    vi.useFakeTimers()
    try {
      const cli = target()
      const pending = exitAfterStderr("gone\n", 1, 1_000, cli)
      await vi.advanceTimersByTimeAsync(999)
      expect(cli.exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(cli.exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
