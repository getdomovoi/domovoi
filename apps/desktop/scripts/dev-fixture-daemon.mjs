// A fixture daemon for the desktop development loop. It speaks the real
// protocol over a real loopback WebSocket, so the renderer connects the way it
// connects to a daemon, and it holds its state in this process, so a renderer
// reload and a main-process relaunch both come back to the same fixture.
//
// It is never evidence: every parameter is parsed with the protocol's own
// schema, every result is parsed before it is sent, and a method with no
// handler is refused out loud rather than answered with a plausible shape.
import { randomUUID } from "node:crypto"

import { WebSocketServer } from "ws"

import { demoWorkspace, rpcMethods } from "@getdomovoi/protocol"

const methodNotFound = -32601
const invalidParams = -32602
const internalError = -32603

export function createFixtureState(seed = demoWorkspace) {
  let snapshot = structuredClone(seed)
  return {
    snapshot: () => snapshot,
    replace(next) {
      snapshot = next
      return snapshot
    },
    patch(changes) {
      snapshot = { ...snapshot, ...changes }
      return snapshot
    },
  }
}

// Read methods answer from the fixture. Write methods move the fixture the way
// the daemon would and answer with the snapshot the protocol says they answer
// with, so the client's own state machine is exercised.
export function createFixtureHandlers(state, connectionId = randomUUID()) {
  const snapshot = () => state.snapshot()
  const activate = (sessionId) => {
    const known = snapshot().sessions.some((session) => session.id === sessionId)
    if (!known) throw new FixtureRefusal(invalidParams, `No fixture session ${sessionId}`)
    return state.patch({ activeSessionId: sessionId })
  }
  return {
    "system.hello": () => ({
      ...snapshot(),
      connectionId,
      sessionImageAttachments: true,
    }),
    "workspace.get": () => snapshot(),
    // The fixture fleet is empty on purpose: this machine is the fixture, and a
    // fabricated second machine would draw a fleet nobody can act on.
    "fleet.list": () => ({ entries: [] }),
    "session.activate": (params) => activate(params.sessionId),
    // The fixture accepts a send so the composer can be driven end to end, and
    // says so on the terminal. It runs no agent, so no reply ever streams back:
    // an empty thread after this line is the fixture, not a broken composer.
    "session.send": (params) => {
      console.log(`[fixture] accepted session.send for ${params.sessionId}. No agent runs here, so no reply streams back.`)
      return snapshot()
    },
    "project.open": () => snapshot(),
    // Usage is drawn in the chrome, so the fixture has to answer it. The
    // numbers are the fixture's own and are not a measurement of anything.
    "usage.window": () => ({
      inputTokens: 38_200,
      cachedInputTokens: 11_400,
      outputTokens: 3_900,
      reasoningTokens: 0,
      totalTokens: 42_100,
      costMicros: 380_000,
      sessions: snapshot().sessions.length,
      turns: 12,
      reportedCostTurns: 12,
      unavailableCostTurns: 0,
    }),
    "session.usage": (params) => ({
      inputTokens: 12_800,
      cachedInputTokens: 4_100,
      outputTokens: 1_500,
      reasoningTokens: 0,
      totalTokens: 14_300,
      costMicros: 120_000,
      sessionId: params.sessionId,
      reportedCostTurns: 4,
      unavailableCostTurns: 0,
      byRuntime: [],
    }),
    // An empty list is the fixture's honest answer: this machine has no
    // installed skills or discovered models, and inventing some would draw
    // rows nobody can act on.
    "skill.list": () => [],
    "runtime.models": () => [],
  }
}

export class FixtureRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// The fixture answers a request the way the daemon does, or refuses it in a way
// nobody can mistake for an answer.
export function answer(handlers, request) {
  const definition = rpcMethods[request.method]
  if (!definition) throw new FixtureRefusal(methodNotFound, `Unknown method ${request.method}`)
  const handler = handlers[request.method]
  if (!handler) {
    throw new FixtureRefusal(
      methodNotFound,
      `${request.method} has no fixture handler. Add one in apps/desktop/scripts/dev-fixture-daemon.mjs.`,
    )
  }
  const params = definition.params.safeParse(request.params ?? {})
  if (!params.success) throw new FixtureRefusal(invalidParams, `${request.method}: ${params.error.message}`)
  const result = definition.result.safeParse(handler(params.data))
  if (!result.success) {
    throw new FixtureRefusal(internalError, `${request.method} answered off-protocol: ${result.error.message}`)
  }
  return result.data
}

export function start({ port = 0, host = "127.0.0.1", log = console.log } = {}) {
  const state = createFixtureState()
  const handlers = createFixtureHandlers(state)
  const server = new WebSocketServer({ host, port, path: "/rpc" })
  server.on("connection", (socket) => {
    log(`[fixture] renderer connected (fixture state kept, pid ${process.pid})`)
    socket.on("message", (data) => {
      let request
      try {
        request = JSON.parse(String(data))
      } catch {
        return
      }
      if (request.id === undefined) return
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answer(handlers, request) }))
      } catch (cause) {
        const code = cause instanceof FixtureRefusal ? cause.code : internalError
        log(`[fixture] refused ${request.method}: ${cause.message}`)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message: cause.message } }))
      }
    })
  })
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address()
      resolve({ url: `ws://${host}:${address.port}/rpc`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DOMOVOI_DEV_FIXTURE_PORT ?? 0)
  const fixture = await start({ port })
  console.log(`DOMOVOI_DEV_FIXTURE_URL=${fixture.url}`)
}
