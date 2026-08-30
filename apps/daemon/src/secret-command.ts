import type { ReadStream, WriteStream } from "node:tty"

import {
  ProviderSecretManager,
  ProviderSecretUnavailableError,
  type DirectApiProvider,
} from "./provider-secrets.js"

const providers = new Set<DirectApiProvider>(["anthropic", "openai", "openrouter"])

type SecretManager = Pick<ProviderSecretManager, "status" | "set" | "delete">

export type ProviderSecretCommandDependencies = {
  manager: SecretManager
  readSecret: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export async function runProviderSecretCommand(
  args: readonly string[],
  dependencies: ProviderSecretCommandDependencies,
): Promise<number> {
  if (args[0] !== "secret") return 1
  const action = args[1]

  if (action === "status" && args.length === 2) {
    for (const status of dependencies.manager.status()) {
      dependencies.stdout(`${status.provider}: ${status.state}\n`)
    }
    return 0
  }

  if (action === "set") {
    if (args.length !== 3) {
      dependencies.stderr("Usage: domovoid secret set <provider>\n")
      return 1
    }
    const provider = supportedProvider(args[2])
    if (!provider) {
      dependencies.stderr("Unsupported provider\n")
      return 1
    }
    let secret: string
    try {
      secret = await dependencies.readSecret()
    } catch {
      dependencies.stderr("Could not read provider key from local terminal\n")
      return 1
    }
    if (!secret.trim()) {
      dependencies.stderr("Provider key cannot be empty\n")
      return 1
    }
    try {
      dependencies.manager.set(provider, secret)
    } catch (error) {
      dependencies.stderr(
        error instanceof ProviderSecretUnavailableError
          ? "OS keychain is unavailable on this machine\n"
          : "OS keychain operation failed\n",
      )
      return 1
    }
    dependencies.stdout(`${provider}: stored\n`)
    return 0
  }

  if (action === "delete" && args.length === 3) {
    const provider = supportedProvider(args[2])
    if (!provider) {
      dependencies.stderr("Unsupported provider\n")
      return 1
    }
    try {
      dependencies.manager.delete(provider)
    } catch (error) {
      dependencies.stderr(
        error instanceof ProviderSecretUnavailableError
          ? "OS keychain is unavailable on this machine\n"
          : "OS keychain operation failed\n",
      )
      return 1
    }
    dependencies.stdout(`${provider}: not-set\n`)
    return 0
  }

  dependencies.stderr("Usage: domovoid secret <status|set|delete> [provider]\n")
  return 1
}

export function readHiddenSecret(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Interactive terminal required"))
  }

  output.write("Provider key: ")
  return new Promise((resolve, reject) => {
    let value = ""
    let finished = false
    const wasRaw = input.isRaw
    const finish = (result?: string, error?: Error) => {
      if (finished) return
      finished = true
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("error", onError)
      try {
        input.setRawMode(Boolean(wasRaw))
      } catch {
        error ??= new Error("Terminal state could not be restored")
      }
      input.pause()
      output.write("\n")
      if (error) reject(error)
      else resolve(result ?? "")
    }
    const onEnd = () => finish(undefined, new Error("Input ended"))
    const onError = () => finish(undefined, new Error("Input failed"))
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish(value)
          return
        }
        if (character === "\u0003") {
          finish(undefined, new Error("Input cancelled"))
          return
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1)
          continue
        }
        if (value.length < 32_768) value += character
      }
    }
    input.on("data", onData)
    input.once("end", onEnd)
    input.once("error", onError)
    try {
      input.setRawMode(true)
    } catch {
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("error", onError)
      output.write("\n")
      reject(new Error("Terminal raw mode is unavailable"))
      return
    }
    input.resume()
  })
}

function supportedProvider(value: string | undefined): DirectApiProvider | undefined {
  return providers.has(value as DirectApiProvider) ? value as DirectApiProvider : undefined
}
