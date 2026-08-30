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
