import { describe, expect, it, vi } from "vitest"

import { maximumTerminalOutputChunkCharacters } from "@getdomovoi/protocol"

import { TerminalOutputBatcher, TerminalOutputBackpressure } from "./terminal-output.js"

describe("TerminalOutputBatcher", () => {
  it("coalesces bursty PTY chunks into one scheduled notification", () => {
    const scheduled: Array<() => void> = []
    const output: string[] = []
    const batcher = new TerminalOutputBatcher(
      (terminalId, data) => { output.push(`${terminalId}:${data}`) },
      (callback) => { scheduled.push(callback); return callback },
      () => {},
    )

    for (let index = 0; index < 1_000; index += 1) batcher.push("terminal-1", "x")

    expect(scheduled).toHaveLength(1)
    expect(output).toEqual([])
    scheduled[0]!()
    expect(output).toEqual([`terminal-1:${"x".repeat(1_000)}`])
  })

  it("bounds every wire chunk without losing terminal bytes or order", () => {
    const scheduled: Array<() => void> = []
    const output: string[] = []
    const batcher = new TerminalOutputBatcher(
      (_terminalId, data) => { output.push(data) },
      (callback) => { scheduled.push(callback); return callback },
      () => {},
    )
    const source = `${"a".repeat(maximumTerminalOutputChunkCharacters)}bc`

    batcher.push("terminal-1", source)
    for (const callback of scheduled) callback()

    expect(output.every((chunk) => chunk.length <= maximumTerminalOutputChunkCharacters)).toBe(true)
    expect(output.join("")).toBe(source)
  })

  it("retains pending output while backpressure is paused and resumes in order", () => {
    const output: string[] = []
    let emitCount = 0
    const batcher = new TerminalOutputBatcher((_terminalId, data) => {
      output.push(data)
      emitCount += 1
      return emitCount === 1
    })
    const source = `${"a".repeat(maximumTerminalOutputChunkCharacters)}${"b".repeat(maximumTerminalOutputChunkCharacters)}tail`

    batcher.push("terminal-1", source)

    expect(output).toEqual(["a".repeat(maximumTerminalOutputChunkCharacters)])
    batcher.resume("terminal-1")
    batcher.flush("terminal-1")
    expect(output.every((chunk) => chunk.length <= maximumTerminalOutputChunkCharacters)).toBe(true)
    expect(output.join("")).toBe(source)
  })
})

describe("TerminalOutputBackpressure", () => {
  it("pauses above the high-water mark and resumes below the low-water mark", () => {
    const process = { pause: vi.fn(), resume: vi.fn() }
    const onLowWater = vi.fn()
    const scheduled: Array<() => void> = []
    let bufferedBytes = 2 * 1_024 * 1_024
    const pressure = new TerminalOutputBackpressure(
      process,
      () => bufferedBytes,
      (callback) => { scheduled.push(callback); return callback },
      () => {},
      onLowWater,
    )

    pressure.observe()
    expect(process.pause).toHaveBeenCalledOnce()
    expect(scheduled).toHaveLength(1)
    bufferedBytes = 0
    scheduled[0]!()
    expect(process.resume).toHaveBeenCalledOnce()
    expect(onLowWater).toHaveBeenCalledOnce()
  })
})

describe("terminal output resize markers", () => {
  function stream(pauseOutput = () => false, pauseResize = () => false) {
    const events: string[] = []
    const scheduled = new Set<() => void>()
    const batcher = new TerminalOutputBatcher(
      (id, data) => { events.push(`${id}:output:${data}`); return pauseOutput() },
      (callback) => { scheduled.add(callback); return callback },
      (timer) => { scheduled.delete(timer as () => void) },
      (id, size) => { events.push(`${id}:resize:${size.cols}x${size.rows}`); return pauseResize() },
    )
    const beat = () => {
      for (const callback of [...scheduled]) { scheduled.delete(callback); callback() }
    }
    return { batcher, events, scheduled, beat }
  }

  it("drains partial old output and the marker immediately, then batches new output", () => {
    const { batcher, events, scheduled, beat } = stream()
    batcher.push("t", "old ")
    batcher.push("t", "grid")
    expect(events).toEqual([])
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    expect(events).toEqual(["t:output:old grid", "t:resize:100x30"])
    expect(scheduled.size).toBe(0)
    batcher.push("t", "new grid")
    expect(events).toHaveLength(2)
    beat()
    expect(events).toEqual(["t:output:old grid", "t:resize:100x30", "t:output:new grid"])
  })

  it("coalesces adjacent queued markers without moving output across a marker", () => {
    let paused = true
    const { batcher, events } = stream(() => paused)
    batcher.push("t", "x".repeat(maximumTerminalOutputChunkCharacters))
    events.length = 0
    batcher.pushResize("t", { cols: 90, rows: 30 }, { cols: 80, rows: 24 })
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 90, rows: 30 })
    batcher.push("t", "between")
    batcher.pushResize("t", { cols: 110, rows: 40 }, { cols: 100, rows: 30 })
    batcher.pushResize("t", { cols: 120, rows: 40 }, { cols: 110, rows: 40 })
    batcher.push("t", "after")
    expect(events).toEqual([])
    paused = false
    batcher.resume("t")
    expect(events).toEqual(["t:resize:100x30", "t:output:between", "t:resize:120x40", "t:output:after"])
  })

  it("stops after a marker pauses and resumes all following events in order", () => {
    let paused = true
    const { batcher, events, beat } = stream(() => false, () => paused)
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    batcher.push("t", "new grid")
    batcher.pushResize("t", { cols: 120, rows: 40 }, { cols: 100, rows: 30 })
    batcher.push("t", "next grid")
    beat()
    expect(events).toEqual(["t:resize:100x30"])
    paused = false
    batcher.resume("t")
    expect(events).toEqual(["t:resize:100x30", "t:output:new grid", "t:resize:120x40", "t:output:next grid"])
  })

  it("holds a marker when draining its preceding output pauses", () => {
    let paused = true
    const { batcher, events } = stream(() => paused)
    batcher.push("t", "old grid")
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    expect(events).toEqual(["t:output:old grid"])
    paused = false
    batcher.resume("t")
    expect(events).toEqual(["t:output:old grid", "t:resize:100x30"])
  })

  it("flushes paused output and markers in order and cancels the pending beat", () => {
    const { batcher, events, scheduled, beat } = stream(() => true)
    batcher.push("t", "old")
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    batcher.push("t", "middle")
    batcher.pushResize("t", { cols: 120, rows: 40 }, { cols: 100, rows: 30 })
    batcher.push("t", "tail")
    batcher.flush("t")
    expect(events).toEqual(["t:output:old", "t:resize:100x30", "t:output:middle", "t:resize:120x40", "t:output:tail"])
    expect(scheduled.size).toBe(0)
    beat()
    expect(events).toHaveLength(5)
  })

  it("drains partial output now and preserves a resulting pause until resume", () => {
    let paused = true
    const { batcher, events, scheduled, beat } = stream(() => paused)
    batcher.push("t", "pending")
    batcher.drainNow("t")
    expect(events).toEqual(["t:output:pending"])
    expect(scheduled.size).toBe(0)
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    batcher.push("t", "after")
    batcher.drainNow("t")
    beat()
    expect(events).toEqual(["t:output:pending"])
    expect(batcher.queuedOutputCharacters("t")).toBe(5)
    paused = false
    batcher.resume("t")
    expect(events).toEqual(["t:output:pending", "t:resize:100x30", "t:output:after"])
    expect(batcher.queuedOutputCharacters("t")).toBe(0)
  })

  it("drains partial output now without leaving a duplicate scheduled delivery", () => {
    const { batcher, events, scheduled, beat } = stream()
    batcher.drainNow("unknown")
    batcher.push("t", "partial")
    batcher.drainNow("t")
    expect(events).toEqual(["t:output:partial"])
    expect(scheduled.size).toBe(0)
    beat()
    expect(events).toEqual(["t:output:partial"])
  })

  it("counts only queued output across markers, partial drains, resume and flush", () => {
    let paused = true
    const { batcher } = stream(() => paused)
    expect(batcher.queuedOutputCharacters("t")).toBe(0)
    batcher.push("t", `${"x".repeat(maximumTerminalOutputChunkCharacters)}tail`)
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 80, rows: 24 })
    batcher.push("t", "after")
    expect(batcher.queuedOutputCharacters("t")).toBe(9)
    expect(batcher.queuedOutputCharacters("other")).toBe(0)
    batcher.resume("t")
    expect(batcher.queuedOutputCharacters("t")).toBe(5)
    paused = false
    batcher.resume("t")
    expect(batcher.queuedOutputCharacters("t")).toBe(0)
    batcher.push("t", "pending")
    expect(batcher.queuedOutputCharacters("t")).toBe(7)
    batcher.flush("t")
    expect(batcher.queuedOutputCharacters("t")).toBe(0)
  })

  it("tracks the starting grid across coalesced markers and partial drains", () => {
    let pauseOutput = true
    let pauseResize = true
    const { batcher } = stream(() => pauseOutput, () => pauseResize)
    expect(batcher.queuedStartSize("t")).toBeUndefined()
    batcher.push("t", "x".repeat(maximumTerminalOutputChunkCharacters))
    batcher.push("t", "old")
    batcher.pushResize("t", { cols: 90, rows: 27 }, { cols: 80, rows: 24 })
    batcher.pushResize("t", { cols: 100, rows: 30 }, { cols: 90, rows: 27 })
    batcher.push("t", "middle")
    batcher.pushResize("t", { cols: 120, rows: 40 }, { cols: 100, rows: 30 })
    expect(batcher.queuedStartSize("t")).toEqual({ cols: 80, rows: 24 })
    expect(batcher.queuedStartSize("other")).toBeUndefined()
    batcher.resume("t") // Old output drains, but its boundary still waits.
    expect(batcher.queuedStartSize("t")).toEqual({ cols: 80, rows: 24 })
    pauseOutput = false
    batcher.resume("t") // The coalesced boundary drains and pauses delivery.
    expect(batcher.queuedStartSize("t")).toEqual({ cols: 100, rows: 30 })
    pauseResize = false
    batcher.resume("t")
    expect(batcher.queuedStartSize("t")).toBeUndefined()
    batcher.push("t", "current grid")
    expect(batcher.queuedStartSize("t")).toBeUndefined()
    batcher.flush("t")
    expect(batcher.queuedStartSize("t")).toBeUndefined()
  })

  it("keeps a pause when the last full output chunk emptied the queue", () => {
    let paused = true
    const { batcher, events, beat } = stream(() => paused)
    batcher.push("t", "x".repeat(maximumTerminalOutputChunkCharacters))
    batcher.push("t", "held")
    beat()
    expect(events).toHaveLength(1)
    paused = false
    batcher.resume("t")
    expect(events.at(-1)).toBe("t:output:held")
  })
})
