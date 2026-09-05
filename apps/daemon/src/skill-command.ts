import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto"
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

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

export type SkillCommandDependencies = {
  home: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = [
  "Usage: domovoid skill keygen <private-key-path>",
  "       domovoid skill sign <skill-path> --key <private-key-path>",
  "       domovoid skill trust <public-key> [--trust-file <path>]",
  "keygen writes a new Ed25519 private key to the named file and prints its public half.",
  "sign writes SKILL.md.sig beside the skill. trust adds a public key to the local trust file.",
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
  dependencies.stderr(usage)
  return 1
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
