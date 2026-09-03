import { describe, expect, it } from "vitest"

import { maximumTerminalReplayCharacters } from "@getdomovoi/protocol"

import { TerminalReplayBuffer } from "./terminal-replay.js"

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

function labelled(index: number, length: number): string {
  return `${index}:`.padEnd(length, String.fromCharCode(97 + (index % 26))).slice(0, length)
}

describe("TerminalReplayBuffer", () => {
  it("reads exactly what concatenating and slicing every chunk would", () => {
    const random = seededRandom(2026)
    for (let round = 0; round < 300; round += 1) {
      const capacity = 1 + Math.floor(random() * 96)
      const buffer = new TerminalReplayBuffer(capacity)
      let expected = ""
      const chunks = Math.floor(random() * 48)
      for (let index = 0; index < chunks; index += 1) {
        const chunk = labelled(round * 100 + index, Math.floor(random() * capacity * 2.5))
        buffer.push(chunk)
        expected = `${expected}${chunk}`.slice(-capacity)
        expect(buffer.read()).toBe(expected)
        expect(buffer.heldCharacters).toBeLessThan(capacity * 2)
      }
    }
  })

  it("crosses the window boundary one character at a time", () => {
    const buffer = new TerminalReplayBuffer(4)
    const seen: string[] = []
    for (const character of "abcdefg") {
      buffer.push(character)
      buffer.push("")
      seen.push(buffer.read())
    }
    expect(seen).toEqual(["a", "ab", "abc", "abcd", "bcde", "cdef", "defg"])
  })

  it("keeps only the tail of a chunk larger than the window", () => {
    const buffer = new TerminalReplayBuffer(8)
    buffer.push("0123")
    buffer.push("abcdefghijklmnop")
    expect(buffer.read()).toBe("ijklmnop")
    expect(buffer.heldCharacters).toBe(8)
    buffer.push("qr")
    expect(buffer.read()).toBe("klmnopqr")
  })

  it("holds less than one segment beyond the window", () => {
    const buffer = new TerminalReplayBuffer(100)
    buffer.push("z".repeat(1_000))
    for (let index = 0; index < 50; index += 1) {
      buffer.push(labelled(index, 30))
      expect(buffer.heldCharacters).toBeLessThan(200)
    }
    expect(buffer.heldCharacters).toBeLessThan(130)
    expect(buffer.read()).toHaveLength(100)
  })

  it("replays the last window of a megabyte of output in order", () => {
    const buffer = new TerminalReplayBuffer()
    const chunks: string[] = []
    for (let index = 0; index < 2_048; index += 1) chunks.push(`${labelled(index, 512)}\n`)
    for (const chunk of chunks) buffer.push(chunk)
    const everything = chunks.join("")
    expect(everything.length).toBeGreaterThan(maximumTerminalReplayCharacters * 3)
    expect(buffer.read()).toBe(everything.slice(-maximumTerminalReplayCharacters))
    expect(buffer.read()).toHaveLength(maximumTerminalReplayCharacters)
    expect(buffer.heldCharacters).toBeLessThan(maximumTerminalReplayCharacters + 513)
  })
})
