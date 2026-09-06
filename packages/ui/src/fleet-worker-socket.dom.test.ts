import { afterEach, expect, it, vi } from "vitest"
import { FleetWorkerSocket } from "./fleet-worker-socket.js"

afterEach(() => vi.unstubAllGlobals())

it("forwards socket traffic and closes the worker without forwarding remote close text", () => {
  class WorkerDouble extends EventTarget {
    static current: WorkerDouble
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor(readonly url: string) { super(); WorkerDouble.current = this }
  }
  vi.stubGlobal("Worker", WorkerDouble)
  const socket = new FleetWorkerSocket("wss://studio.example/rpc", "ticket")
  const worker = WorkerDouble.current
  expect(worker.url).toBe("/fleet-socket.js?route=ticket")
  expect(worker.postMessage).toHaveBeenCalledWith({ type: "open", url: "wss://studio.example/rpc" })
  const received = vi.fn()
  socket.addEventListener("message", received)
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "open" } }))
  expect(socket.readyState).toBe(1)
  socket.send("client receipt request")
  expect(worker.postMessage).toHaveBeenCalledWith({ type: "send", data: "client receipt request" })
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "message", data: "answer" } }))
  expect(received.mock.calls[0]?.[0].data).toBe("answer")
  const closed = vi.fn()
  socket.addEventListener("close", closed)
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "close", code: 1008, reason: "secret from remote" } }))
  expect(socket.readyState).toBe(3)
  expect(closed.mock.calls[0]?.[0].code).toBe(1008)
  expect(closed.mock.calls[0]?.[0].reason).toBe("")
  expect(worker.terminate).toHaveBeenCalledOnce()
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "open" } }))
  expect(socket.readyState).toBe(3)
})
