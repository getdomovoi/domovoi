import { maximumTerminalReplayCharacters } from "@getdomovoi/protocol"

export type TerminalReplayRecord = {
  text: string
  // When the oldest character still held was printed; undefined when empty.
  startsAt: number | undefined
  // Whether output before the record was printed and is no longer held.
  dropped: boolean
}

export class TerminalReplayBuffer {
  readonly capacity: number
  readonly #segments: string[] = []
  readonly #segmentTimes: number[] = []
  readonly #now: () => number
  #held = 0
  #dropped = false

  constructor(capacity = maximumTerminalReplayCharacters, now: () => number = Date.now) {
    this.capacity = capacity
    this.#now = now
  }

  get heldCharacters(): number {
    return this.#held
  }

  push(text: string): void {
    if (!text) return
    const at = this.#now()
    if (text.length >= this.capacity) {
      if (this.#held > 0 || text.length > this.capacity) this.#dropped = true
      this.#segments.length = 0
      this.#segmentTimes.length = 0
      this.#segments.push(text.slice(-this.capacity))
      this.#segmentTimes.push(at)
      this.#held = this.capacity
      return
    }
    this.#segments.push(text)
    this.#segmentTimes.push(at)
    this.#held += text.length
    while (this.#segments.length > 1 && this.#held - this.#segments[0]!.length >= this.capacity) {
      this.#held -= this.#segments.shift()!.length
      this.#segmentTimes.shift()
      this.#dropped = true
    }
  }

  read(): string {
    return this.#segments.join("").slice(-this.capacity)
  }

  record(): TerminalReplayRecord {
    return {
      text: this.read(),
      startsAt: this.#segmentTimes[0],
      dropped: this.#dropped || this.#held > this.capacity,
    }
  }
}
