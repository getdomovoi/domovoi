import { execFile } from "node:child_process"
import { promisify } from "node:util"

export type WslRunner<Output extends string | Buffer> = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<Output>

// A wsl.exe call that fails does so in one of five ways, each with its own
// remedy, so a failure says which: WSL is absent from the machine, the call
// was denied, it timed out, the service or the distribution is unavailable,
// or what came back cannot be read. None of them is "no distribution".
export type WslFailureKind = "absent" | "denied" | "timed-out" | "unavailable" | "corrupt"

export class WslError extends Error {
  readonly kind: WslFailureKind

  constructor(kind: WslFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "WslError"
    this.kind = kind
  }
}

export type WslCallFailure = {
  kind: Exclude<WslFailureKind, "corrupt">
  detail: string
}

const execute = promisify(execFile)

// wsl.exe talks to a service that can be starting, stopping, or wedged, and a
// call that never comes back would hold up whatever asked for it.
export const defaultWslTimeoutMs = 10_000

const unsafeCharacters = new Set(["\"", "\\", "/"])

// A control character or a separator in the name would either be swallowed by
// wsl.exe or would name a different distribution than the one asked for.
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    if (unsafeCharacters.has(character)) return true
    if ((character.codePointAt(0) ?? 0) < 0x20) return true
  }
  return false
}

export function assertDistributionName(distribution: string): string {
  if (distribution === "" || hasUnsafeCharacter(distribution) || distribution.startsWith("-")) {
    throw new Error(`${JSON.stringify(distribution)} is not a distribution wsl.exe can be asked for`)
  }
  return distribution
}

// Every wsl.exe call is an argument list handed to the process directly, so
// a distribution name or a path is never re-read by a shell.
export async function runWslText(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<string> {
  const { stdout } = await execute(command, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  })
  return stdout
}

export async function runWslBytes(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<Buffer> {
  const { stdout } = await execute(command, [...args], {
    encoding: "buffer",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  })
  return stdout
}

// A timeout of zero or less would leave the child with no deadline at all,
// which is the opposite of what asking for one means.
export function wslTimeoutMs(requested: number | undefined): number {
  return requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested
    : defaultWslTimeoutMs
}

export function wslSeconds(timeoutMs: number): string {
  return `${Number((timeoutMs / 1000).toFixed(3))} seconds`
}

export function withWslDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WslError("timed-out", "wsl.exe did not answer in time")), timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

// wsl.exe writes its own messages in UTF-16, and a command inside the
// distribution writes UTF-8, so what came back is read either way. Bytes of
// UTF-16 that were read as UTF-8 leave a NUL after every character, which
// dropping the NULs undoes.
export function wslText(output: unknown): string {
  let text: string
  if (Buffer.isBuffer(output)) {
    const utf16 = output.length >= 2 && ((output[0] === 0xff && output[1] === 0xfe) || output[1] === 0)
    text = output.toString(utf16 ? "utf16le" : "utf8")
  } else if (typeof output === "string") {
    text = output
  } else {
    return ""
  }
  return text.split("\0").join("").replace(/\uFEFF|\uFFFD/g, "")
}

function isPrintable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code >= 0x20 && code !== 0x7f
}

// The first thing wsl.exe or the distribution said, without the error code
// line wsl.exe appends and without anything a terminal would act on. The
// caller chooses what it is safe to read: stdout is the answer, and for an
// endpoint file the answer is a credential.
export function firstSaid(...outputs: readonly unknown[]): string {
  const line = outputs
    .flatMap((output) => wslText(output).split(/\r?\n/))
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !/^Error code:/i.test(candidate)) ?? ""
  return Array.from(line).filter(isPrintable).join("").slice(0, 200)
}

const deniedWords = /access is denied|permission denied|E_ACCESSDENIED|ACCESS_DENIED|0x80070005/i
const absentWords = /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|optional component is not enabled|Subsystem for Linux is not installed|WSL_E_NOT_INSTALLED/i

export function classifyWslFailure(error: unknown, said: string): WslCallFailure {
  if (error instanceof WslError && error.kind !== "corrupt") return { kind: error.kind, detail: error.message }
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown
    killed?: unknown
    signal?: unknown
    message?: unknown
  }
  if (failure.code === "ENOENT") return { kind: "absent", detail: "wsl.exe is not installed" }
  if (failure.code === "EACCES" || failure.code === "EPERM") {
    return { kind: "denied", detail: `access to wsl.exe was denied (${failure.code})` }
  }
  if (failure.killed === true || failure.signal === "SIGKILL" || failure.code === "ETIMEDOUT") {
    return { kind: "timed-out", detail: "wsl.exe did not answer in time" }
  }
  if (deniedWords.test(said)) return { kind: "denied", detail: said }
  if (absentWords.test(said)) return { kind: "absent", detail: said }
  const message = typeof failure.message === "string" ? failure.message.split(/\r?\n/)[0] ?? "" : ""
  return { kind: "unavailable", detail: said || message || "wsl.exe failed" }
}
