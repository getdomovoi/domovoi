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

type TerminalSize = { cols: number; rows: number }
type OutputEntry = { kind: "output"; data: string } | { kind: "resize"; size: TerminalSize }
type PendingOutput = { entries: OutputEntry[]; paused: boolean; timer?: Timer }

export class TerminalOutputBatcher {
  readonly #pending = new Map<string, PendingOutput>()

  constructor(
    readonly emit: (terminalId: string, data: string) => boolean | void,
    readonly schedule: Schedule = scheduleTimeout,
    readonly cancel: Cancel = cancelTimeout,
    readonly emitResize: (terminalId: string, size: TerminalSize) => boolean | void = () => {},
  ) {}

  push(terminalId: string, data: string): void {
    if (!data) return
    const pending = this.#pending.get(terminalId) ?? { entries: [], paused: false }
    const tail = pending.entries.at(-1)
    if (tail?.kind === "output") tail.data += data
    else pending.entries.push({ kind: "output", data })
    this.#pending.set(terminalId, pending)
    if (!pending.paused) this.#drain(terminalId, pending, false)
  }

  pushResize(terminalId: string, size: TerminalSize): void {
    const pending = this.#pending.get(terminalId) ?? { entries: [], paused: false }
    const tail = pending.entries.at(-1)
    if (tail?.kind === "resize") tail.size = size
    else pending.entries.push({ kind: "resize", size })
    this.#pending.set(terminalId, pending)
    if (!pending.paused) this.#drain(terminalId, pending, false)
  }

  resume(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (!pending?.paused) return
    pending.paused = false
    this.#drain(terminalId, pending, true)
  }

  drainNow(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (!pending || pending.paused) return
    this.#drain(terminalId, pending, true)
  }

  queuedOutputCharacters(terminalId: string): number {
    return this.#pending.get(terminalId)?.entries.reduce(
      (total, entry) => total + (entry.kind === "output" ? entry.data.length : 0),
      0,
    ) ?? 0
  }

  #emitNext(terminalId: string, pending: PendingOutput): boolean | void {
    const entry = pending.entries[0]!
    if (entry.kind === "resize") {
      pending.entries.shift()
      return this.emitResize(terminalId, entry.size)
    }
    const chunk = entry.data.slice(0, maximumTerminalOutputChunkCharacters)
    entry.data = entry.data.slice(chunk.length)
    if (!entry.data) pending.entries.shift()
    return this.emit(terminalId, chunk)
  }

  #drain(terminalId: string, pending: PendingOutput, includePartial: boolean): void {
    while (pending.entries.length > 0) {
      const entry = pending.entries[0]!
      // A marker is a boundary: even a partial chunk before it goes first.
      if (entry.kind === "output" && entry.data.length < maximumTerminalOutputChunkCharacters
        && !includePartial && pending.entries.length === 1) break
      if (this.#emitNext(terminalId, pending) === true) {
        pending.paused = true
        break
      }
    }
    if (pending.paused || pending.entries.length === 0) {
      if (pending.timer !== undefined) this.cancel(pending.timer)
      pending.timer = undefined
      // Keep an empty paused queue so a later push cannot bypass high water.
      if (!pending.paused) this.#pending.delete(terminalId)
    } else if (pending.timer === undefined) {
      const timer = this.schedule(() => {
        if (this.#pending.get(terminalId) !== pending || pending.timer !== timer) return
        pending.timer = undefined
        this.#drain(terminalId, pending, true)
      }, terminalOutputBatchDelayMilliseconds)
      pending.timer = timer
    }
  }

  // Final delivery ignores pauses. Live stream boundaries must use drainNow.
  flush(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (!pending) return
    if (pending.timer !== undefined) this.cancel(pending.timer)
    this.#pending.delete(terminalId)
    while (pending.entries.length > 0) this.#emitNext(terminalId, pending)
  }
}

export class TerminalOutputBackpressure {
  #paused = false
  #timer: Timer | undefined

  get paused(): boolean {
    return this.#paused
  }

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
