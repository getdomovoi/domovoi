import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto"
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import {
  skillInstallScopeSchema,
  type SkillInstallPreview,
  type SkillInstallScope,
  type SkillInstallTarget,
} from "@getdomovoi/protocol"

import {
  SkillInstallError,
  skillInstallRefusalMessage,
  SkillSourceError,
} from "./skill-install.js"
import {
  addTrustedSkillKey,
  exportSkillPublicKey,
  generateSkillSigningKey,
  signSkillDigest,
  skillContentDigest,
  skillKeyId,
  skillSignatureVersion,
  skillTrustPath,
} from "./skill-signing.js"
import { FileSkillCatalog, skillRoots } from "./skills.js"

export type SkillCommandDependencies = {
  home: string
  cwd: () => string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = [
  "Usage: domovoid skill keygen <private-key-path>",
  "       domovoid skill sign <skill-path> --key <private-key-path>",
  "       domovoid skill trust <public-key> [--trust-file <path>]",
  "       domovoid skill add <skill-path> --scope <project|user> [--yes]",
  "keygen writes a new Ed25519 private key to the named file and prints its public half.",
  "sign writes SKILL.md.sig beside the skill. trust adds a public key to the local trust file.",
  "add reviews a skill folder and, with --yes, copies it into the scope's Domovoi skill directory.",
  "The project scope is the working directory.",
  "",
].join("\n")

export async function runSkillCommand(
  args: readonly string[],
  dependencies: SkillCommandDependencies,
): Promise<number> {
  if (args[0] !== "skill") return 1
  const action = args[1]
  if (action === "--help" && args.length === 2) {
    dependencies.stdout(usage)
    return 0
  }
  if (action === "keygen" && args.length === 3) return keygen(args[2]!, dependencies)
  if (action === "sign" && args.length === 5 && args[3] === "--key") {
    return sign(args[2]!, args[4]!, dependencies)
  }
  if (action === "trust" && (args.length === 3 || (args.length === 5 && args[3] === "--trust-file"))) {
    return trust(args[2]!, args[4] ?? skillTrustPath(dependencies.home), dependencies)
  }
  if (action === "add" && args.length >= 3) {
    const options = addOptions(args.slice(3))
    if (options) return add(args[2]!, options.scope, options.yes, dependencies)
  }
  dependencies.stderr(usage)
  return 1
}

function addOptions(flags: readonly string[]): { scope: SkillInstallScope; yes: boolean } | undefined {
  let scope: SkillInstallScope | undefined
  let yes = false
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === "--yes") {
      yes = true
      continue
    }
    if (flag === "--scope" && scope === undefined) {
      const parsed = skillInstallScopeSchema.safeParse(flags[index + 1])
      if (!parsed.success) return undefined
      scope = parsed.data
      index += 1
      continue
    }
    return undefined
  }
  return scope === undefined ? undefined : { scope, yes }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unreadable"
}

async function keygen(path: string, dependencies: SkillCommandDependencies): Promise<number> {
  const keyPath = resolve(path)
  const { privateKey, publicKey } = generateSkillSigningKey()
  const pem = privateKey.export({ type: "pkcs8", format: "pem" })
  try {
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
    const handle = await open(keyPath, "wx", 0o600)
    try {
      await handle.writeFile(pem, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    dependencies.stderr(
      errorCode(error) === "EEXIST"
        ? `Key file already exists: ${keyPath}\n`
        : `Could not write the key file at ${keyPath}: ${errorCode(error)}\n`,
    )
    return 1
  }
  dependencies.stdout([
    `wrote private key to ${keyPath}`,
    `key id:     ${skillKeyId(publicKey)}`,
    `public key: ${exportSkillPublicKey(publicKey)}`,
    "",
  ].join("\n"))
  return 0
}

async function readSigningKey(path: string): Promise<KeyObject> {
  let pem: string
  try {
    pem = await readFile(path, "utf8")
  } catch (error) {
    throw new Error(`Could not read the signing key at ${path}: ${errorCode(error)}`, { cause: error })
  }
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o077) !== 0) {
    throw new Error(`Signing key must not be readable by other users: ${path}`)
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    throw new Error(`Signing key is not a PEM encoded private key: ${path}`, { cause: error })
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Signing key is not an Ed25519 key: ${path}`)
  }
  return key
}

async function sign(
  skillPath: string,
  keyPath: string,
  dependencies: SkillCommandDependencies,
): Promise<number> {
  const resolved = resolve(skillPath)
  const target = basename(resolved) === "SKILL.md" ? resolved : join(resolved, "SKILL.md")
  let privateKey: KeyObject
  try {
    privateKey = await readSigningKey(resolve(keyPath))
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : "Could not read the signing key"}\n`)
    return 1
  }
  let content: string
  try {
    content = await readFile(target, "utf8")
  } catch (error) {
    dependencies.stderr(`Could not read the skill at ${target}: ${errorCode(error)}\n`)
    return 1
  }
  const contentDigest = skillContentDigest(content)
  const keyId = skillKeyId(createPublicKey(privateKey))
  const declaration = {
    version: skillSignatureVersion,
    contentDigest,
    algorithm: "ed25519",
    keyId,
    value: signSkillDigest(contentDigest, privateKey),
  }
  const signaturePath = `${target}.sig`
  try {
    await writeFile(signaturePath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8")
  } catch (error) {
    dependencies.stderr(`Could not write the signature at ${signaturePath}: ${errorCode(error)}\n`)
    return 1
  }
  dependencies.stdout([
    `signed ${target} with ${keyId}`,
    `content digest: ${contentDigest}`,
    `signature: ${signaturePath}`,
    "",
  ].join("\n"))
  return 0
}

function reviewLines(
  preview: SkillInstallPreview,
  scope: SkillInstallScope,
  target: SkillInstallTarget | undefined,
): string {
  const row = (label: string, value: string) => `${`${label}:`.padEnd(16)}${value}`
  const signature = preview.signature.state === "unsigned"
    ? "unsigned"
    : preview.signature.state === "invalid"
      ? `invalid · ${preview.signature.reason}`
      : `${preview.signature.state} · ${preview.signature.keyId}`
  const trust = preview.trust.state === "trusted"
    ? `trusted (${preview.trust.reason}) · ${preview.trust.authority}`
    : `${preview.trust.state} (${preview.trust.reason})`
  const totalBytes = preview.files.reduce((sum, file) => sum + file.bytes, 0)
  return [
    row("skill", preview.name),
    row("description", preview.description),
    row("capabilities", preview.manifest.capabilities.join(", ") || "none declared"),
    row("signature", signature),
    row("trust", trust),
    row("content digest", preview.contentDigest),
    row("source digest", preview.sourceDigest),
    row("files", `${preview.files.length} (${totalBytes} bytes)`),
    row("installs to", target ? `${target.path} (${target.state})` : `no ${scope} skill directory`),
    ...preview.refusals.map((refusal) => `refused: ${skillInstallRefusalMessage(refusal)}`),
    "",
  ].join("\n")
}

async function add(
  skillPath: string,
  scope: SkillInstallScope,
  yes: boolean,
  dependencies: SkillCommandDependencies,
): Promise<number> {
  const source = { kind: "path" as const, path: resolve(skillPath) }
  const catalog = new FileSkillCatalog(skillRoots(dependencies.home, dependencies.cwd()), undefined, {
    trustPath: skillTrustPath(dependencies.home),
  })
  let preview: SkillInstallPreview
  try {
    preview = await catalog.installPreview(source)
  } catch (error) {
    if (!(error instanceof SkillSourceError)) throw error
    dependencies.stderr(`${error.message}\n`)
    return 1
  }
  const target = preview.targets.find((candidate) => candidate.scope === scope)
  dependencies.stdout(reviewLines(preview, scope, target))
  if (preview.refusals.length > 0) {
    dependencies.stderr(preview.refusals.map((refusal) => `refused: ${skillInstallRefusalMessage(refusal)}\n`).join(""))
    return 1
  }
  if (!yes) {
    dependencies.stdout("Nothing installed. Re-run with --yes to install.\n")
    return 0
  }
  try {
    const installed = await catalog.install({ source, scope, sourceDigest: preview.sourceDigest })
    dependencies.stdout(`installed ${installed.name} to ${target?.path ?? dirname(installed.path)}\n`)
    return 0
  } catch (error) {
    if (error instanceof SkillInstallError) {
      dependencies.stderr(`refused: ${error.message}\n`)
      return 1
    }
    if (!(error instanceof SkillSourceError)) throw error
    dependencies.stderr(`${error.message}\n`)
    return 1
  }
}

async function trust(
  encodedPublicKey: string,
  trustFile: string,
  dependencies: SkillCommandDependencies,
): Promise<number> {
  const path = resolve(trustFile)
  try {
    const { keyId, added } = await addTrustedSkillKey(path, encodedPublicKey)
    dependencies.stdout(added
      ? `trusted ${keyId} in ${path}\n`
      : `${keyId} is already trusted in ${path}\n`)
    return 0
  } catch (error) {
    dependencies.stderr(
      `${error instanceof Error ? error.message : "Could not update the skill trust file"}\n`,
    )
    return 1
  }
}
