#!/usr/bin/env node
import { homedir } from "node:os"

import { CredentialStoreError, nativeKeyring, openCredentialStore } from "./credentials.js"
import { protocolVersion } from "@getdomovoi/protocol"

import { diagnose, renderDoctor } from "./doctor.js"
import { readLogs, renderLogs } from "./logs.js"
import { pairWithDaemon, PairingError, readCredential } from "./pair.js"
import { readPlainLine, readSecretLine } from "./secret-input.js"
import { installSkill, previewSkill, renderPreview, SkillInstallError } from "./skill-install.js"
import { connectToDaemon, DaemonUnreachableError, defaultEndpoint } from "./rpc.js"
import { collectStatus, renderStatus } from "./status.js"

const usage = `Usage:
  domovoi pair   [--daemon <ws-url>] [--credential-file <path>]   reads the credential from stdin
  domovoi status [--daemon <ws-url>] [--credential-file <path>]
  domovoi doctor [--daemon <ws-url>] [--credential-file <path>]
  domovoi logs   [--limit <n>] [--action <name>] [--outcome <o>] [--session <id>] [--before <id>]
  domovoi skill install <path> [--scope user|project] [--yes]

doctor: checks the daemon, your credential and the protocol, then for each fleet machine reports
the route this daemon would choose for you and why the others lost. Exit 1 on any failed probe.
logs: your own copy of the machine's audit log, read over your channel; nothing is uploaded. It is
a paged query, so there is no --follow; page with --before.
skill install: previews (files, digests, signature, trust, target), then installs the previewed
digest into the chosen scope; enabling is a separate decision on the daemon.

Pairing: on the machine that runs the daemon, run 'domovoid pair --client cli'. It prints one
client credential. Paste that line (or the credential alone) into 'domovoi pair'. The
credential is read from stdin so it never lands in shell history or the process table.
Credentials live in the OS keychain. Where there is none (a headless host, WSL, a container),
pass --credential-file to keep them in a file you own; the CLI never writes one on its own.
Default daemon: ${defaultEndpoint}
`

type Options = { positional: string[]; daemon: string; credentialFile?: string; limit: number; action?: string; outcome?: string; session?: string; before?: string; scope: "user" | "project"; yes: boolean }

function parse(argv: string[]): Options {
  const options: Options = { positional: [], daemon: defaultEndpoint, limit: 50, scope: "user", yes: false }
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
    else if (argument === "--limit") {
      const limit = Number(value())
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError("--limit takes a whole number from 1 to 500")
      options.limit = limit
    }
    else if (argument === "--action") options.action = value()
    else if (argument === "--outcome") options.outcome = value()
    else if (argument === "--session") options.session = value()
    else if (argument === "--before") options.before = value()
    else if (argument === "--scope") {
      const scope = value()
      if (scope !== "user" && scope !== "project") throw new UsageError("--scope is user or project")
      options.scope = scope
    }
    else if (argument === "--yes" || argument === "-y") options.yes = true
    else if (argument === "--help" || argument === "-h") options.positional.unshift("help")
    else if (argument.startsWith("--")) throw new UsageError(`Unknown option ${argument}`)
    else options.positional.push(argument)
  }
  return options
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv)
  const [command] = options.positional
  const store = () => openCredentialStore({
    keyring: nativeKeyring(), home: homedir(), warn: (text) => process.stderr.write(`${text}\n`),
    ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }),
  })

  if (command === "pair") {
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
      process.stderr.write(`Not paired with ${options.daemon}. Run 'domovoid pair --client cli' where the daemon runs, then paste its credential into 'domovoi pair --daemon ${options.daemon}${options.credentialFile === undefined ? "" : ` --credential-file ${options.credentialFile}`}'.\n`)
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

  const paired = async () => {
    const credentials = await store()
    const record = await credentials.load(options.daemon)
    if (!record) {
      process.stderr.write(`Not paired with ${options.daemon}. Run 'domovoid pair --client cli' where the daemon runs, then paste its credential into 'domovoi pair --daemon ${options.daemon}${options.credentialFile === undefined ? "" : ` --credential-file ${options.credentialFile}`}'.\n`)
      return undefined
    }
    return connectToDaemon({ endpoint: options.daemon, authToken: record.token })
  }

  // Surplus arguments are a wrong command, not noise: refuse before any
  // connection or RPC, so a stray word cannot ride along with --yes.
  const exactly = (count: number, shape: string) => {
    if (options.positional.length !== count) throw new UsageError(`${shape} takes no further arguments; got ${options.positional.slice(count).map((word) => JSON.stringify(word)).join(" ")}`)
  }
  if (command === "pair" || command === "status" || command === "doctor" || command === "logs") exactly(1, `domovoi ${command}`)
  if (command === "skill" && options.positional[1] === "install") exactly(3, "domovoi skill install <path>")

  if (command === "doctor") {
    const connection = await paired()
    if (!connection) return 2
    try {
      const report = await diagnose({ endpoint: options.daemon, clientProtocolVersion: protocolVersion, call: connection.call })
      process.stdout.write(renderDoctor(report))
      return report.failed ? 1 : 0
    } finally {
      connection.close()
    }
  }

  if (command === "logs") {
    const connection = await paired()
    if (!connection) return 2
    try {
      const query = { limit: options.limit, ...(options.action ? { action: options.action } : {}), ...(options.outcome ? { outcome: options.outcome } : {}),
        ...(options.session ? { session: options.session } : {}), ...(options.before ? { before: options.before } : {}) }
      process.stdout.write(renderLogs(await readLogs({ call: connection.call, query })))
      return 0
    } finally {
      connection.close()
    }
  }

  if (command === "skill" && options.positional[1] === "install") {
    const path = options.positional[2]
    if (path === undefined) throw new UsageError("skill install needs the path of the skill directory")
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) throw new UsageError("skill install takes an absolute path; the daemon reads it, not this shell")
    const connection = await paired()
    if (!connection) return 2
    try {
      const preview = await previewSkill({ call: connection.call, path })
      process.stdout.write(renderPreview(preview, options.scope))
      if (!options.yes) {
        const answer = (await readPlainLine("Install into the " + options.scope + " scope? [y/N] ")).trim().toLowerCase()
        if (answer !== "y" && answer !== "yes") { process.stdout.write("not installed\n"); return 1 }
      }
      const installed = await installSkill({ call: connection.call, path, scope: options.scope, preview })
      process.stdout.write(`installed ${installed.name} at ${installed.path} (${installed.scope}); enable it on the daemon when you have read it\n`)
      return 0
    } finally {
      connection.close()
    }
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
  if (error instanceof CredentialStoreError || error instanceof PairingError || error instanceof DaemonUnreachableError || error instanceof SkillInstallError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
