// Every change to a protocol schema is a wire change, and clients and daemons
// must already match on protocol major and minor. So a schema change ships with
// a minor bump, and a patch carries no wire change. This script records a digest
// of every schema the protocol package exports, and every RPC's params and
// result, in packages/protocol/wire-schema.json, and checks a change against the
// last protocol release tag, or the given base when no tag exists.
//
//   node scripts/protocol-wire.mjs write              regenerate the record
//   node scripts/protocol-wire.mjs check --base <ref> compare against the base
//
// Both read the built package, so run `pnpm --filter @getdomovoi/protocol build`
// first. The comparison reads the base's committed record with git; it never
// regenerates the base, so a change cannot vouch for itself.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const wireSchemaPath = "packages/protocol/wire-schema.json"
const releaseTagPatterns = ["@getdomovoi/protocol@*", "protocol-v*"]

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function digest(z, schema) {
  const document = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" })
  return `sha256:${createHash("sha256").update(canonical(document)).digest("hex")}`
}

function isSchema(value) {
  return typeof value === "object" && value !== null && "_zod" in value
}

export async function currentWire(directory = root) {
  const protocolPackage = join(directory, "packages/protocol/package.json")
  const z = createRequire(protocolPackage)("zod")
  const protocol = await import(pathToFileURL(join(directory, "packages/protocol/dist/index.js")).href)
  const schemas = {}
  for (const name of Object.keys(protocol).sort()) {
    if (isSchema(protocol[name])) schemas[name] = digest(z, protocol[name])
  }
  for (const method of Object.keys(protocol.rpcMethods).sort()) {
    schemas[`rpcMethods.${method}.params`] = digest(z, protocol.rpcMethods[method].params)
    schemas[`rpcMethods.${method}.result`] = digest(z, protocol.rpcMethods[method].result)
  }
  return { protocolVersion: protocol.protocolVersion, schemas }
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Protocol version is malformed: ${version}`)
  return match.slice(1, 3).map(BigInt)
}

export function wireChangeRefusal(base, current) {
  const [baseMajor, baseMinor] = versionParts(base.protocolVersion)
  const [major, minor] = versionParts(current.protocolVersion)
  const bumped = major > baseMajor || (major === baseMajor && minor > baseMinor)
  if (major < baseMajor || (major === baseMajor && minor < baseMinor)) {
    return `Protocol version ${current.protocolVersion} is older than the base's ${base.protocolVersion}.`
  }
  const names = new Set([...Object.keys(base.schemas), ...Object.keys(current.schemas)])
  const changed = [...names].sort().filter((name) => base.schemas[name] !== current.schemas[name])
  if (changed.length === 0 || bumped) return undefined
  const listed = changed.slice(0, 20).join(", ") + (changed.length > 20 ? `, and ${changed.length - 20} more` : "")
  return `Protocol schemas changed without a minor version bump (${base.protocolVersion} to ${current.protocolVersion}): ${listed}. ` +
    "Every wire change is a minor bump; raise protocolVersion in packages/protocol/src/protocol-version.ts."
}

// A base from before this record existed (the last shipped protocol, for
// example) cannot say which schemas changed. Only a raised protocol version
// covers every change since it, so that is what such a base requires.
export function unrecordedBaseRefusal(baseVersion, currentVersion) {
  if (baseVersion === undefined) {
    return "The base has no wire record and this check cannot read its protocol version, so it cannot tell whether the wire changed."
  }
  const [baseMajor, baseMinor] = versionParts(baseVersion)
  const [major, minor] = versionParts(currentVersion)
  if (major > baseMajor || (major === baseMajor && minor > baseMinor)) return undefined
  return `The base has no wire record and the protocol version was not raised (${baseVersion} to ${currentVersion}), so this check cannot tell whether the wire changed.`
}

export function protocolVersionIn(source) {
  return /export const protocolVersion = "(\d+\.\d+\.\d+)"/.exec(source)?.[1]
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function baseline(fallback) {
  const tags = git(["tag", "--list", ...releaseTagPatterns, "--merged", "HEAD", "--sort=-creatordate"])
    .split("\n").map((tag) => tag.trim()).filter(Boolean)
  return tags[0] ?? fallback
}

function readBase(ref) {
  try {
    return JSON.parse(git(["show", `${ref}:${wireSchemaPath}`]))
  } catch {
    return undefined
  }
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === "write") {
    writeFileSync(join(root, wireSchemaPath), `${JSON.stringify(await currentWire(), null, 2)}\n`)
    return 0
  }
  if (command !== "check") {
    process.stderr.write("Usage: node scripts/protocol-wire.mjs write | check --base <ref>\n")
    return 2
  }
  const baseIndex = rest.indexOf("--base")
  const fallback = baseIndex >= 0 ? rest[baseIndex + 1] : undefined
  if (!fallback) {
    process.stderr.write("check needs --base <ref> for when no protocol release tag exists\n")
    return 2
  }
  const current = await currentWire()
  const committed = JSON.parse(readFileSync(join(root, wireSchemaPath), "utf8"))
  if (canonical(committed) !== canonical(current)) {
    process.stderr.write(`${wireSchemaPath} is out of date with the built protocol. Run node scripts/protocol-wire.mjs write.\n`)
    return 1
  }
  const ref = baseline(fallback)
  const base = readBase(ref)
  if (!base) {
    let source
    try {
      source = git(["show", `${ref}:packages/protocol/src/protocol-version.ts`])
    } catch {
      source = ""
    }
    const baseVersion = protocolVersionIn(source)
    const refusal = unrecordedBaseRefusal(baseVersion, current.protocolVersion)
    if (refusal) {
      process.stderr.write(`${refusal}\nCompared against ${ref}.\n`)
      return 1
    }
    process.stdout.write(`${ref} has no ${wireSchemaPath}; protocol ${current.protocolVersion} is above its ${baseVersion}, which covers any wire change since it.\n`)
    return 0
  }
  const refusal = wireChangeRefusal(base, current)
  if (refusal) {
    process.stderr.write(`${refusal}\nCompared against ${ref}.\n`)
    return 1
  }
  process.stdout.write(`Protocol wire matches its version against ${ref}.\n`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2))
}
