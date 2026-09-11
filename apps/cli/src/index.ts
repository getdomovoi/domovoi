#!/usr/bin/env node
import { homedir } from "node:os"
import { stdin } from "node:process"
import { createInterface } from "node:readline/promises"

import { CredentialStoreError, nativeKeyring, openCredentialStore } from "./credentials.js"
import { pairWithDaemon, PairingError, readCredential } from "./pair.js"
import { connectToDaemon, DaemonUnreachableError, defaultEndpoint } from "./rpc.js"
import { collectStatus, renderStatus } from "./status.js"

const usage = `Usage:
  domovoi pair   [--daemon <ws-url>] [--credential-file <path>]   reads the credential from stdin
  domovoi status [--daemon <ws-url>] [--credential-file <path>]

Pairing: on the machine that runs the daemon, run 'domovoid pair --client cli'. It prints one
client credential. Paste that line (or the credential alone) into 'domovoi pair'. The
credential is read from stdin so it never lands in shell history or the process table.
Credentials live in the OS keychain. Where there is none (a headless host, WSL, a container),
pass --credential-file to keep them in a file you own; the CLI never writes one on its own.
Default daemon: ${defaultEndpoint}
`

type Options = { positional: string[]; daemon: string; credentialFile?: string }

function parse(argv: string[]): Options {
  const options: Options = { positional: [], daemon: defaultEndpoint }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError(`${argument} needs a value`)
      index += 1
      return next
    }
    if (argument === "--daemon") options.daemon = value()
    else if (argument === "--credential-file") options.credentialFile = value()
    else if (argument === "--help" || argument === "-h") options.positional.unshift("help")
    else if (argument.startsWith("--")) throw new UsageError(`Unknown option ${argument}`)
    else options.positional.push(argument)
  }
  return options
}

class UsageError extends Error {}

// A terminal gets a prompt with echo off; a pipe is read as is. Either way
// one line, and nothing of it is written back.
async function readSecretLine(): Promise<string> {
  if (!stdin.isTTY) {
    let text = ""
    for await (const chunk of stdin) text += chunk.toString()
    return text
  }
  const reader = createInterface({ input: stdin, output: process.stderr, terminal: true })
  const mute = (reader as unknown as { _writeToOutput: (text: string) => void })
  const original = mute._writeToOutput
  mute._writeToOutput = (text: string) => { if (text.includes("credential")) original.call(reader, text) }
  try {
    return await reader.question("Paste the client credential: ")
  } finally {
    process.stderr.write("\n")
    reader.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv)
  const [command] = options.positional
  const store = () => openCredentialStore({
    keyring: nativeKeyring(), home: homedir(), warn: (text) => process.stderr.write(`${text}\n`),
    ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }),
  })

  if (command === "pair") {
    if (options.positional.length > 1) throw new UsageError("pair takes the credential on stdin, not as an argument")
    const credentials = await store()
    const credential = readCredential(await readSecretLine())
    const paired = await pairWithDaemon({
      endpoint: options.daemon, credential, store: credentials,
      connect: (authToken) => connectToDaemon({ endpoint: options.daemon, authToken }),
    })
    process.stdout.write(`Paired with ${paired.machineId} as device ${paired.deviceId}. Credential stored in the ${credentials.where}.\n`)
    return 0
  }

  if (command === "status") {
    const credentials = await store()
    const paired = await credentials.load(options.daemon)
    if (!paired) {
      process.stderr.write(`Not paired with ${options.daemon}. Run 'domovoi pair <code>' first.\n`)
      return 2
    }
    const connection = await connectToDaemon({ endpoint: options.daemon, authToken: paired.token })
    try {
      process.stdout.write(renderStatus(await collectStatus({ endpoint: options.daemon, call: connection.call })))
    } finally {
      connection.close()
    }
    return 0
  }

  process.stderr.write(usage)
  return command === undefined || command === "--help" || command === "help" ? 0 : 2
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${usage}`)
    process.exitCode = 2
    return
  }
  if (error instanceof CredentialStoreError || error instanceof PairingError || error instanceof DaemonUnreachableError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
