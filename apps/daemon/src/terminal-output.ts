import {
  maximumTerminalOutputChunkCharacters,
  terminalOutputBatchDelayMilliseconds,
  terminalWebSocketHighWaterBytes,
  terminalWebSocketLowWaterBytes,
} from "@getdomovoi/protocol"

type Timer = unknown
type Schedule = (callback: () => void, delayMilliseconds: number) => Timer
type Cancel = (timer: Timer) => void

const scheduleTimeout: Schedule = (callback, delay) => setTimeout(callback, delay)
const cancelTimeout: Cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)

type PendingOutput = { data: string; paused: boolean; timer?: Timer }

export class TerminalOutputBatcher {
  readonly #pending = new Map<string, PendingOutput>()

  constructor(
    readonly emit: (terminalId: string, data: string) => boolean | void,
    readonly schedule: Schedule = scheduleTimeout,
    readonly cancel: Cancel = cancelTimeout,
  ) {}

  push(terminalId: string, data: string): void {
    if (!data) return
    const pending = this.#pending.get(terminalId) ?? { data: "", paused: false }
    pending.data += data
    this.#pending.set(terminalId, pending)
    if (pending.paused) return
    this.#drain(terminalId, pending, false)
  }

  resume(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (!pending?.paused) return
    pending.paused = false
    this.#drain(terminalId, pending, true)
  }

  #drain(terminalId: string, pending: PendingOutput, includePartial: boolean): void {
    while (
      pending.data.length >= maximumTerminalOutputChunkCharacters
      || (includePartial && pending.data.length > 0)
    ) {
      const chunk = pending.data.slice(0, maximumTerminalOutputChunkCharacters)
      pending.data = pending.data.slice(chunk.length)
      if (this.emit(terminalId, chunk) === true) {
        pending.paused = true
        if (pending.timer !== undefined) this.cancel(pending.timer)
        pending.timer = undefined
        break
      }
    }
    if (!pending.data) {
      if (pending.timer !== undefined) this.cancel(pending.timer)
      this.#pending.delete(terminalId)
    } else if (!pending.paused && pending.timer === undefined) {
      const timer = this.schedule(() => {
        if (this.#pending.get(terminalId) !== pending || pending.timer !== timer) return
        pending.timer = undefined
        this.#drain(terminalId, pending, true)
      }, terminalOutputBatchDelayMilliseconds)
      pending.timer = timer
    }
  }

  flush(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (!pending) return
    if (pending.timer !== undefined) this.cancel(pending.timer)
    this.#pending.delete(terminalId)
    for (let offset = 0; offset < pending.data.length; offset += maximumTerminalOutputChunkCharacters) {
      this.emit(terminalId, pending.data.slice(offset, offset + maximumTerminalOutputChunkCharacters))
    }
  }
}

export class TerminalOutputBackpressure {
  #paused = false
  #timer: Timer | undefined

  constructor(
    readonly process: { pause?(): void; resume?(): void },
    readonly bufferedBytes: () => number,
    readonly schedule: Schedule = scheduleTimeout,
    readonly cancel: Cancel = cancelTimeout,
    readonly onLowWater: () => void = () => {},
  ) {}

  observe(): boolean {
    if (!this.#paused && this.bufferedBytes() >= terminalWebSocketHighWaterBytes) {
      this.process.pause?.()
      this.#paused = true
    }
    if (this.#paused && this.#timer === undefined) this.#scheduleCheck()
    return this.#paused
  }

  dispose(): void {
    if (this.#timer !== undefined) this.cancel(this.#timer)
    this.#timer = undefined
  }

  #scheduleCheck(): void {
    const timer = this.schedule(() => {
      if (this.#timer !== timer) return
      this.#timer = undefined
      if (this.bufferedBytes() <= terminalWebSocketLowWaterBytes) {
        this.process.resume?.()
        this.#paused = false
        this.onLowWater()
      } else {
        this.#scheduleCheck()
      }
    }, terminalOutputBatchDelayMilliseconds)
    this.#timer = timer
  }
}
