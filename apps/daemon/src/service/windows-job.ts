import { execFileSync, spawn } from "node:child_process"
import type { EventEmitter } from "node:events"
import type { Readable, Writable } from "node:stream"
import { gzipSync } from "node:zlib"
import { z } from "zod"

import { windowsBootIdSchema, windowsProcessIdentitySchema, windowsJobNameSchema, type WindowsProcessIdentity } from "./supervisor-record.js"
import { windowsPowerShellPath } from "./windows-task.js"
import { windowsJobSource } from "./windows-job-source.js"
import type { ServiceCommand } from "./install.js"

const preparedSchema = z.object({
  kind: z.literal("prepared"), job: windowsJobNameSchema, bootId: windowsBootIdSchema,
  child: windowsProcessIdentitySchema, helper: windowsProcessIdentitySchema, killOnClose: z.literal(true),
}).strict().refine((p) => p.child.bootId === p.bootId && p.helper.bootId === p.bootId)
const emptySchema = z.object({
  kind: z.literal("empty"), job: windowsJobNameSchema, bootId: windowsBootIdSchema, activeProcesses: z.literal(0), terminated: z.literal(true),
  code: z.number().int().min(0).max(4_294_967_295), stopped: z.boolean(),
}).strict()
const messageSchema = z.union([preparedSchema, emptySchema, z.object({ kind: z.literal("running"), job: windowsJobNameSchema }).strict()])
export type WindowsJobEmpty = z.infer<typeof emptySchema>
export type WindowsJob = {
  prepared: z.infer<typeof preparedSchema>
  resume(): Promise<void>
  exited: Promise<WindowsJobEmpty>
  stop(): Promise<WindowsJobEmpty>
}
export type WindowsJobInput = { job: string; executable: string; args: string[]; log: string }
export type WindowsJobTransport = (command: ServiceCommand) => EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill(): unknown }

export function windowsJobCommand(): ServiceCommand {
  // Compress only the fixed, checked-in source to fit CreateProcess's command
  // line limit. No launch value enters this bootstrap or the compiled source.
  const source = gzipSync(Buffer.from(windowsJobSource)).toString("base64")
  const script = `$bytes=[Convert]::FromBase64String('${source}');$stream=[IO.Compression.GzipStream]::new([IO.MemoryStream]::new($bytes),[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($stream);& ([ScriptBlock]::Create($reader.ReadToEnd()))`
  return { command: windowsPowerShellPath(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }
}
export function parseWindowsJobMessage(value: unknown, job: string): z.infer<typeof messageSchema> {
  const message = messageSchema.parse(value)
  if (message.job !== job) throw new Error("Windows helper answered for another job")
  return message
}

// A failed/denied query is never evidence of a different boot or a dead PID.
export function queryWindowsProcess(pid: number): { bootId: string; identity: WindowsProcessIdentity | null } {
  const observation = queryWindowsProcesses([pid])
  return { bootId: observation.bootId, identity: observation.identities[0]! }
}
export function queryWindowsProcesses(pids: number[]): { bootId: string; identities: (WindowsProcessIdentity | null)[] } {
  z.array(windowsProcessIdentitySchema.shape.pid).min(1).max(8).parse(pids)
  const command = windowsJobCommand()
  const output = execFileSync(command.command, command.args, { input: JSON.stringify({ mode: "inspect", pids }) + "\n",
    encoding: "utf8", timeout: 20_000, maxBuffer: 8192, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  return z.object({ bootId: windowsBootIdSchema, identities: z.array(windowsProcessIdentitySchema.nullable()).length(pids.length) }).strict()
    .refine((value) => value.identities.every((identity, i) => !identity || (identity.bootId === value.bootId && identity.pid === pids[i])))
    .parse(JSON.parse(output))
}
export function windowsProcessAlive(identity: WindowsProcessIdentity): boolean {
  const observed = queryWindowsProcess(identity.pid)
  return observed.bootId === identity.bootId && observed.identity?.start === identity.start
}

export function launchWindowsJob(input: WindowsJobInput, transport: WindowsJobTransport = (command) =>
  spawn(command.command, command.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })): Promise<WindowsJob> {
  windowsJobNameSchema.parse(input.job)
  return new Promise((resolve, reject) => {
    const child = transport(windowsJobCommand())
    let prepared: z.infer<typeof preparedSchema> | undefined
    let receipt: WindowsJobEmpty | undefined
    let closed = false, resumed = false, running = false, failed = false
    let buffer = ""
    let resolveExit!: (value: WindowsJobEmpty) => void, rejectExit!: (error: unknown) => void
    let resolveResume!: () => void, rejectResume!: (error: unknown) => void
    const exited = new Promise<WindowsJobEmpty>((yes, no) => { resolveExit = yes; rejectExit = no })
    const resumeResult = new Promise<void>((yes, no) => { resolveResume = yes; rejectResume = no })
    void exited.catch(() => {}); void resumeResult.catch(() => {})
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const send = (command: "resume" | "stop") => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ command }) + "\n") }
    const requestStop = () => {
      send("stop")
      stopTimer ??= setTimeout(() => { child.kill(); fail(new Error("Windows helper did not provide job-empty proof before the stop deadline")) }, 15_000)
    }
    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      clearTimeout(startTimer)
      reject(error); rejectResume(error); rejectExit(error)
      if (!closed) requestStop()
    }
    const startTimer = setTimeout(() => fail(new Error("Windows job startup handshake expired; tree unconfirmed")), 25_000)
    child.stdin.on("error", (error) => fail(error))
    child.on("error", (error) => fail(error))
    child.stderr.resume()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (failed) return
      try {
        buffer += chunk
        if (buffer.length > 8192) throw new Error("Windows job evidence exceeds its byte limit")
        let end: number
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          const message = parseWindowsJobMessage(JSON.parse(line), input.job)
          if (receipt) throw new Error("Windows helper sent evidence after its terminal receipt")
          if (message.kind === "prepared") {
            if (prepared) throw new Error("Windows helper repeated its preparation")
            prepared = message; clearTimeout(startTimer)
            resolve({ prepared, exited, resume: () => {
              if (resumed || receipt || failed) return Promise.reject(new Error("Windows job cannot resume twice or after termination"))
              resumed = true; send("resume"); return resumeResult
            }, stop: () => { if (!closed) requestStop(); return exited } })
          } else if (message.kind === "running") {
            if (!prepared || !resumed || running) throw new Error("Windows helper resumed outside the startup gate")
            running = true; resolveResume()
          } else {
            if (!prepared || message.bootId !== prepared.bootId) throw new Error("Windows job-empty proof has no matching prepared attempt")
            receipt = message
          }
        }
      } catch (error) { fail(new Error("Windows job evidence is invalid; tree unconfirmed", { cause: error })) }
    })
    child.once("close", (code: number | null) => {
      closed = true; clearTimeout(startTimer); clearTimeout(stopTimer)
      if (failed) return
      if (code !== 0 || !receipt || buffer.trim()) { fail(new Error("Windows helper exited without job-empty proof")); return }
      rejectResume(new Error("Windows job ended before its resume acknowledgement"))
      resolveExit(receipt)
    })
    child.stdin.write(JSON.stringify({ mode: "run", ...input }) + "\n")
  })
}
