// Every change to a protocol schema is a wire change, and clients and daemons
// must already match on protocol major and minor. The rule is per release: all
// wire changes between two releases share one minor bump. Each released protocol
// version has a record of its wire in packages/protocol/wire-releases/, written
// once, at release. The check compares the built package with the record of the
// highest release at or below its protocolVersion: at that same version the wire
// must not have changed; above it, every change since shares the bump.
//
//   node scripts/protocol-wire.mjs check                      compare the build
//   node scripts/protocol-wire.mjs record [--package <root>]  write a release record
//
// Both read a built package (`pnpm --filter @getdomovoi/protocol build` first);
// `record --package` reads another checkout, such as a release commit's tree.
// The wire is what crosses a socket: every RPC's params and result, the payload
// of every notification the daemon sends, and the error data it attaches.
// Exported helpers and aliases are not the wire and are not recorded.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const wireReleasesPath = "packages/protocol/wire-releases"

// Notification method to the exported schema of its payload. A test keeps this
// in step with the daemon's broadcast calls.
export const notificationSchemas = {
  "workspace.changed": "workspaceSnapshotSchema",
  "workspace.delta": "workspaceDeltaSchema",
  "terminal.output": "terminalOutputNotificationSchema",
  "terminal.closed": "terminalClosedNotificationSchema",
  "terminal.ownership": "terminalOwnershipNotificationSchema",
  "fleet.changed": "fleetChangedNotificationSchema",
  "system.emergencyStopped": "systemEmergencyStoppedNotificationSchema",
}

// Structured data attached to RPC errors.
export const errorDataSchemas = [
  "deviceLabelMismatchSchema",
  "fleetSnapshotOverflowSchema",
  "projectSwitchConfirmationSchema",
  "protocolMismatchSchema",
  "sessionAttachmentRefusalSchema",
  "skillInstallRefusalSchema",
  "turnSkillSelectionRefusalSchema",
]

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function isSchema(value) {
  return typeof value === "object" && value !== null && "_zod" in value
}

// JSON Schema leaves out custom checks, so a tightened `.check`, `.refine` or
// `.superRefine` would not move it. Every check in the schema tree is recorded
// too: its kind and plain parameters, the source of a custom check's function,
// and the `wire` semantics a helper such as utf16MaxLength or wireRule declares.
//
// A bound a custom check captures in a closure is invisible here. With
// `requireSemantics`, a custom check that declares no `wire` semantics is
// refused rather than recorded as if it were understood (fail closed). The
// wire record leaves it off: an unannotated closure bound is a stated limit in
// docs/protocol-version-negotiation.md.
export function checksOf(schema, { requireSemantics = false } = {}) {
  const found = []
  const seen = new Set()
  const plain = (value) => value === null || ["string", "number", "boolean"].includes(typeof value)
  const visit = (value, path, depth) => {
    if (depth > 64 || value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1))
      return
    }
    if (isSchema(value)) {
      const def = value._zod.def
      for (const [index, check] of (def.checks ?? []).entries()) {
        const checkDef = check?._zod?.def ?? {}
        const at = `${path}.checks[${index}]`
        if (requireSemantics && checkDef.check === "custom" && checkDef.wire === undefined) {
          throw new Error(`The custom check at ${at} declares no wire semantics. Wrap its schema with wireRule(schema, { rule, ...captured values }) from @getdomovoi/protocol.`)
        }
        const entry = { at }
        for (const [key, item] of Object.entries(checkDef)) {
          if (plain(item)) entry[key] = item
          else if (key === "wire") entry.wire = item
          else if (typeof item === "function") entry[key] = String(item)
        }
        // A superRefine keeps its function on the check itself, not its def.
        if (typeof check?._zod?.check === "function") entry.run = String(check._zod.check)
        found.push(entry)
      }
      for (const [key, item] of Object.entries(def)) {
        if (key === "checks") continue
        visit(item, `${path}.${key}`, depth + 1)
      }
      return
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`, depth + 1)
  }
  visit(schema, "$", 0)
  return found
}

// Descriptions, titles and examples document a schema; they do not change what
// parses, so they are not a wire change.
const documentationKeys = new Set(["description", "title", "examples", "$comment"])

function withoutDocumentation(value) {
  if (Array.isArray(value)) return value.map(withoutDocumentation)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !documentationKeys.has(key))
      .map(([key, item]) => [key, withoutDocumentation(item)]))
  }
  return value
}

export function fingerprintOf(z, schema, options = {}) {
  const document = withoutDocumentation(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }))
  const text = canonical({ jsonSchema: document, checks: checksOf(schema, options) })
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

const fingerprint = (z, schema) => fingerprintOf(z, schema)

export async function wireOf(packageRoot = root) {
  const protocolPackage = join(packageRoot, "packages/protocol/package.json")
  const z = createRequire(protocolPackage)("zod")
  const protocol = await import(pathToFileURL(join(packageRoot, "packages/protocol/dist/index.js")).href)
  const schemas = {}
  for (const method of Object.keys(protocol.rpcMethods).sort()) {
    schemas[`rpc.${method}.params`] = fingerprint(z, protocol.rpcMethods[method].params)
    schemas[`rpc.${method}.result`] = fingerprint(z, protocol.rpcMethods[method].result)
  }
  for (const [method, name] of Object.entries(notificationSchemas)) {
    if (isSchema(protocol[name])) schemas[`notification.${method}`] = fingerprint(z, protocol[name])
  }
  for (const name of errorDataSchemas) {
    if (isSchema(protocol[name])) schemas[`errorData.${name}`] = fingerprint(z, protocol[name])
  }
  return { protocolVersion: protocol.protocolVersion, schemas }
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Protocol version is malformed: ${version}`)
  return match.slice(1).map(BigInt)
}

function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

// The release a build is measured against: the highest recorded release at or
// below its own version.
export function releaseBaseline(releasedVersions, currentVersion) {
  return releasedVersions
    .filter((version) => compareVersions(version, currentVersion) <= 0)
    .sort(compareVersions)
    .at(-1)
}

export function wireChangeRefusal(release, current) {
  const [releaseMajor, releaseMinor] = versionParts(release.protocolVersion)
  const [major, minor] = versionParts(current.protocolVersion)
  if (major > releaseMajor || (major === releaseMajor && minor > releaseMinor)) return undefined
  const names = new Set([...Object.keys(release.schemas), ...Object.keys(current.schemas)])
  const changed = [...names].sort().filter((name) => release.schemas[name] !== current.schemas[name])
  if (changed.length === 0) return undefined
  const listed = changed.slice(0, 20).join(", ") + (changed.length > 20 ? `, and ${changed.length - 20} more` : "")
  return `The wire changed since protocol ${release.protocolVersion} was released, and protocolVersion is still ${current.protocolVersion}: ${listed}. ` +
    "Raise the minor in packages/protocol/src/protocol-version.ts; every wire change until the next release shares that one bump."
}

function releasedVersions() {
  const directory = join(root, wireReleasesPath)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .map((name) => /^(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1])
    .filter((version) => version !== undefined)
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === "record") {
    const packageIndex = rest.indexOf("--package")
    const packageRoot = packageIndex >= 0 ? resolve(rest[packageIndex + 1] ?? "") : root
    const wire = await wireOf(packageRoot)
    mkdirSync(join(root, wireReleasesPath), { recursive: true })
    const path = join(root, wireReleasesPath, `${wire.protocolVersion}.json`)
    if (existsSync(path) && !rest.includes("--replace")) {
      process.stderr.write(`${path} exists; a release record is written once. Pass --replace to rewrite it.\n`)
      return 1
    }
    writeFileSync(path, `${JSON.stringify(wire, null, 2)}\n`)
    process.stdout.write(`Recorded the wire of protocol ${wire.protocolVersion}.\n`)
    return 0
  }
  if (command !== "check") {
    process.stderr.write("Usage: node scripts/protocol-wire.mjs check | record [--package <root>] [--replace]\n")
    return 2
  }
  const current = await wireOf()
  const baseline = releaseBaseline(releasedVersions(), current.protocolVersion)
  if (!baseline) {
    process.stderr.write(`No release record at or below protocol ${current.protocolVersion} in ${wireReleasesPath}, so this check cannot tell what changed.\n`)
    return 1
  }
  const release = JSON.parse(readFileSync(join(root, wireReleasesPath, `${baseline}.json`), "utf8"))
  const refusal = wireChangeRefusal(release, current)
  if (refusal) {
    process.stderr.write(`${refusal}\n`)
    return 1
  }
  process.stdout.write(release.protocolVersion === current.protocolVersion
    ? `Protocol ${current.protocolVersion} matches its release record.\n`
    : `Protocol ${current.protocolVersion} is above the last release, ${release.protocolVersion}; wire changes since then share that bump.\n`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2))
}
