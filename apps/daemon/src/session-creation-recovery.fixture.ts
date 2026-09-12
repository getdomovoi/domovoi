import { once, on } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { WebSocket } from "ws"
import { protocolVersion, workspaceSnapshotSchema, type Runtime } from "@getdomovoi/protocol"
import type { AgentAdapter } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { productionRpcTimeoutMs } from "./test-wait-for.js"
import { GitWorkspaceService, type SessionWorkspace } from "./workspace.js"

export const creationTestRuntime: Runtime = {
  provider: "codex", model: "recovery-fixture", reasoning: "medium", permissionMode: "build", auto: false,
}

export function creationTestAgent(onStart = () => {}): AgentAdapter {
  return {
    connect: async () => {},
    listModels: async () => [{ provider: "codex", id: "recovery-fixture", displayName: "Fixture",
      description: "Crash recovery fixture", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", isDefault: true }],
    startThread: async () => { onStart(); return "fixture-provider-thread" },
    resumeThread: async () => {}, stopThread: async () => {}, startTurn: async () => "fixture-turn",
    steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: async () => {},
    onEvent: () => () => {}, close: async () => {},
  }
}

async function main(root: string, mode: string, phase: string) {
  const seed = workspaceSnapshotSchema.parse(JSON.parse(await readFile(join(root, "seed.json"), "utf8")))
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), seed)
  const workspace = new GitWorkspaceService(join(root, "worktrees"))
  const holdCreated = async (sessionId: string, created: SessionWorkspace) => {
    await writeFile(join(created.path, "uncommitted.txt"), "preserve interrupted setup\n")
    process.send!({ state: "created", sessionId, ...created })
    await new Promise<void>((resolve) => process.once("message", () => resolve()))
    throw new Error("The fixture must be stopped before session setup returns")
  }
  const create = workspace.createSessionWorkspace.bind(workspace)
  const fork = workspace.createSessionWorkspaceFromCheckpoint.bind(workspace)
  if (phase === "before-receipt") {
    workspace.createSessionWorkspace = async (...args) => {
      const created = await create(...args)
      await holdCreated(args[1], created)
      return created
    }
    workspace.createSessionWorkspaceFromCheckpoint = async (...args) => {
      const created = await fork(...args)
      await holdCreated(args[2], created)
      return created
    }
  }
  const agent = creationTestAgent()
  if (phase === "after-receipt") agent.startThread = async ({ cwd }) => {
    await writeFile(join(cwd, "uncommitted.txt"), "preserve interrupted setup\n")
    process.send!({ state: "created", sessionId: basename(cwd), path: cwd })
    await new Promise<void>((resolve) => process.once("message", () => resolve()))
    throw new Error("The fixture must be stopped during provider setup")
  }
  const daemon = new DomovoiDaemon({ port: 0, store, workspaceService: workspace,
    agents: { codex: agent }, agentTimeoutMs: productionRpcTimeoutMs(process.platform) })
  const address = await daemon.start()
  const paired = store.devices.pair({ label: "creation-recovery-fixture", binding: { kind: "client", client: "cli" } })
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  await once(socket, "open")
  const messages = on(socket, "message")
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
    client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: paired.token,
  } }))
  for await (const [data] of messages) {
    const response = JSON.parse(String(data)) as { id?: number; error?: unknown }
    if (response.id === 1) {
      if (response.error) throw new Error(`Fixture hello refused: ${JSON.stringify(response.error)}`)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2,
        method: mode === "fork" ? "session.fork" : "session.create",
        params: mode === "fork"
          ? { sessionId: "session-source", checkpointId: "checkpoint-source", requestId: "creation-recovery-fork", client: "cli", runtime: creationTestRuntime }
          : { title: "Interrupted creation", client: "cli", runtime: creationTestRuntime },
      }))
    } else if (response.id === 2) {
      throw new Error(`Fixture setup returned before the crash point: ${JSON.stringify(response)}`)
    }
  }
}

if (process.argv[2] === "--creation-crash-fixture") {
  const [, , , root, mode, phase] = process.argv
  if (!root || !mode || !phase || !process.send) throw new Error("Missing creation recovery fixture input")
  void main(root, mode, phase).catch((error: unknown) => { console.error(error); process.exit(1) })
}
