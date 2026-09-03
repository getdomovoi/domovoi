import { maximumTerminalReplayCharacters } from "@getdomovoi/protocol"

export class TerminalReplayBuffer {
  readonly capacity: number
  readonly #segments: string[] = []
  #held = 0

  constructor(capacity = maximumTerminalReplayCharacters) {
    this.capacity = capacity
  }

  get heldCharacters(): number {
    return this.#held
  }

  push(text: string): void {
    if (!text) return
    if (text.length >= this.capacity) {
      this.#segments.length = 0
      this.#segments.push(text.slice(-this.capacity))
      this.#held = this.capacity
      return
    }
    this.#segments.push(text)
    this.#held += text.length
    while (this.#segments.length > 1 && this.#held - this.#segments[0]!.length >= this.capacity) {
      this.#held -= this.#segments.shift()!.length
    }
  }

  read(): string {
    return this.#segments.join("").slice(-this.capacity)
  }
}
