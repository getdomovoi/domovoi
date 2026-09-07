import type { ClientSocket } from "./client-socket.js"

// A worker's external script response has its own CSP. No blob/data worker,
// eval, wildcard origin or Node socket sidesteps that browser boundary.
export class FleetWorkerSocket implements ClientSocket {
  readyState = 0
  readonly #events = new EventTarget()
  readonly #worker: Worker

  constructor(url: string, ticket: string) {
    this.#worker = new Worker(`/fleet-socket.js?route=${encodeURIComponent(ticket)}`)
    this.#worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (this.readyState === 3 || !data || typeof data !== "object") return
      const value = data as Record<string, unknown>
      if (value.type === "open") { this.readyState = 1; this.#events.dispatchEvent(new Event("open")) }
      else if (value.type === "message" && typeof value.data === "string") this.#events.dispatchEvent(new MessageEvent("message", { data: value.data }))
      else if (value.type === "error") this.#events.dispatchEvent(new Event("error"))
      else if (value.type === "close") this.#closed(typeof value.code === "number" ? value.code : 1006)
    })
    this.#worker.addEventListener("error", () => { this.#events.dispatchEvent(new Event("error")); this.#closed(1006) })
    this.#worker.postMessage({ type: "open", url })
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: AddEventListenerOptions): void {
    this.#events.addEventListener(type, listener as EventListener, options)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("Client socket is not open")
    this.#worker.postMessage({ type: "send", data })
  }

  close(code = 1000): void { this.#closed(code) }

  #closed(code: number): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#worker.postMessage({ type: "close" })
    this.#worker.terminate()
    this.#events.dispatchEvent(new CloseEvent("close", { code }))
  }
}
