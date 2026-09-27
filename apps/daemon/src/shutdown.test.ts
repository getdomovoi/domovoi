import { describe, expect, it, vi } from "vitest"

import { EventEmitter } from "node:events"

import { installShutdownHandlers, type ShutdownHooks } from "./shutdown.js"

function harness(stopDaemonOverride?: ShutdownHooks["stopDaemon"]): {
  events: EventEmitter
  removeEndpointFile: ReturnType<typeof vi.fn>
  stopDaemon: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  writeStderr: ReturnType<typeof vi.fn>
} {
  const events = new EventEmitter()
  const removeEndpointFile = vi.fn(async () => {})
  const stopDaemon = vi.fn(async () => {})
  const exit = vi.fn()
  const writeStderr = vi.fn()
  installShutdownHandlers(
    {
      removeEndpointFile,
      stopDaemon: stopDaemonOverride ?? stopDaemon,
      exit,
      writeStderr,
    },
    events as unknown as NodeJS.Process,
  )
  return { events, removeEndpointFile, stopDaemon, exit, writeStderr }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("installShutdownHandlers", () => {
  it("exits cleanly once even when signals repeat", async () => {
    const harnessInstance = harness()

    harnessInstance.events.emit("SIGINT")
    harnessInstance.events.emit("SIGINT")
    harnessInstance.events.emit("SIGTERM")
    await settle()

    expect(harnessInstance.removeEndpointFile).toHaveBeenCalledOnce()
    expect(harnessInstance.stopDaemon).toHaveBeenCalledOnce()
    expect(harnessInstance.exit).toHaveBeenCalledTimes(1)
    expect(harnessInstance.exit).toHaveBeenCalledWith(0)
    expect(harnessInstance.writeStderr).not.toHaveBeenCalled()
  })

  it("reports a failed shutdown to stderr and exits nonzero instead of crashing", async () => {
    const failure = new AggregateError([new Error("adapter will not close")], "Domovoi shutdown failed")
    const stopDaemon = vi.fn(async () => { throw failure })
    const harnessInstance = harness(stopDaemon)

    harnessInstance.events.emit("SIGINT")
    await settle()

    expect(harnessInstance.writeStderr).toHaveBeenCalledTimes(1)
    expect(harnessInstance.writeStderr).toHaveBeenCalledWith(
      `domovoid shutdown failed: ${String(failure)}\n`,
    )
    expect(harnessInstance.exit).toHaveBeenCalledWith(1)
    expect(harnessInstance.exit).toHaveBeenCalledTimes(1)
  })

  // Security review of #628: the daemon's stop finishes a running emergency
  // stop's save, so a failed endpoint removal must not skip it.
  it("still stops the daemon when the endpoint file cannot be removed, and reports each failure", async () => {
    const harnessInstance = harness()
    const removal = new Error("endpoint file is locked")
    harnessInstance.removeEndpointFile.mockImplementationOnce(async () => { throw removal })

    harnessInstance.events.emit("SIGTERM")
    await settle()

    expect(harnessInstance.stopDaemon).toHaveBeenCalledOnce()
    expect(harnessInstance.writeStderr).toHaveBeenCalledWith(`domovoid shutdown failed: ${String(removal)}\n`)
    expect(harnessInstance.exit).toHaveBeenCalledTimes(1)
    expect(harnessInstance.exit).toHaveBeenCalledWith(1)
  })

  it("reports both failures when the endpoint removal and the daemon stop both fail", async () => {
    const stopFailure = new Error("store will not close")
    const harnessInstance = harness(vi.fn(async () => { throw stopFailure }))
    const removal = new Error("endpoint file is locked")
    harnessInstance.removeEndpointFile.mockImplementationOnce(async () => { throw removal })

    harnessInstance.events.emit("SIGINT")
    await settle()

    expect(harnessInstance.writeStderr.mock.calls).toEqual([
      [`domovoid shutdown failed: ${String(removal)}\n`],
      [`domovoid shutdown failed: ${String(stopFailure)}\n`],
    ])
    expect(harnessInstance.exit).toHaveBeenCalledTimes(1)
    expect(harnessInstance.exit).toHaveBeenCalledWith(1)
  })

  it("logs unhandled rejections instead of crashing", async () => {
    const harnessInstance = harness()

    harnessInstance.events.emit("unhandledRejection", new Error("boom"))

    expect(harnessInstance.writeStderr).toHaveBeenCalledWith("domovoid unhandled rejection: Error: boom\n")
    expect(harnessInstance.exit).not.toHaveBeenCalled()
  })
})
