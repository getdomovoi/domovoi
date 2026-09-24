// Every change to a protocol schema is a wire change, and clients and daemons
// must already match on protocol major and minor. The rule is per release: all
// wire changes between two releases share one minor bump. Each released protocol
// version has a record of its wire in packages/protocol/wire-releases/, written
// once, at release. The check compares the built package with the record of the
// highest release at or below its protocolVersion: at that same version the wire
// must not have changed; above it, every change since shares the bump.
//
//   node scripts/protocol-wire.mjs check [--base <sha>]       compare the build
//   node scripts/protocol-wire.mjs record [--package <root>]  write a release record
//   node scripts/protocol-wire.mjs verify [--package <root>]  compare a record with its release commit
//
// All read a built package (`pnpm --filter @getdomovoi/protocol build` first);
// `--package` reads another checkout, such as a release commit's tree. With
// `--base`, a release record that existed at that commit must be unchanged.
// When CI is set, check refuses to run without a base it can resolve.
// The wire is what crosses a socket: every RPC's params and result, the payload
// of every notification the daemon sends, and the error data it attaches.
// Exported helpers and aliases are not the wire and are not recorded.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const wireReleasesPath = "packages/protocol/wire-releases"

// Notification method to the exported schema of its payload, for a package
// built before the protocol exported notificationMethods. A newer package is
// read from notificationMethods, the map the daemon checks every payload with.
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
// parses, so they are not a wire change. They are dropped only where they are
// keywords of a schema: under `properties` and the other name maps the same
// words are field names, and under `const`, `enum` and `default` they are data.
const documentationKeys = new Set(["description", "title", "examples", "$comment"])
const nameMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])
const dataKeywords = new Set(["const", "enum", "default", "required", "dependentRequired"])

function withoutDocumentation(schema) {
  if (Array.isArray(schema)) return schema.map(withoutDocumentation)
  if (!schema || typeof schema !== "object") return schema
  const kept = []
  for (const [key, value] of Object.entries(schema)) {
    if (documentationKeys.has(key)) continue
    if (dataKeywords.has(key)) kept.push([key, value])
    else if (nameMaps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      kept.push([key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withoutDocumentation(item)]))])
    } else kept.push([key, withoutDocumentation(value)])
  }
  return Object.fromEntries(kept)
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
  const notifications = protocol.notificationMethods
    ?? Object.fromEntries(Object.entries(notificationSchemas).map(([method, name]) => [method, protocol[name]]))
  for (const method of Object.keys(notifications).sort()) {
    if (isSchema(notifications[method])) schemas[`notification.${method}`] = fingerprint(z, notifications[method])
  }
  for (const name of errorDataSchemas) {
    if (isSchema(protocol[name])) schemas[`errorData.${name}`] = fingerprint(z, protocol[name])
  }
  return { protocolVersion: protocol.protocolVersion, schemas }
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  })
}

// A release record is written once, from its release commit. Every record that
// existed at `base` must still exist here, byte for byte: a rewritten record
// would let a changed wire clear the check it is measured against. A record
// new since `base` is a new release. The base must be an ancestor of HEAD.
export function releasedRecordRefusal(repository, base) {
  try {
    git(repository, ["merge-base", "--is-ancestor", base, "HEAD"])
  } catch {
    return `The base commit ${base} is not an ancestor of HEAD, so it cannot show which release records this checkout changed.`
  }
  const listed = git(repository, ["ls-tree", "-r", "--name-only", base, "--", wireReleasesPath])
    .split("\n").filter((path) => /\.json$/.test(path))
  const problems = []
  for (const path of listed) {
    const name = path.slice(wireReleasesPath.length + 1)
    const current = join(repository, path)
    if (!existsSync(current)) problems.push(`${name} was removed since ${base}`)
    else if (readFileSync(current, "utf8") !== git(repository, ["show", `${base}:${path}`])) {
      problems.push(`${name} changed since ${base}`)
    }
  }
  if (problems.length === 0) return undefined
  return `Released wire records are written once: ${problems.join("; ")}. Restore them; a new release gets a new record.`
}

// A record names the commit it was recorded from. Built at that commit, the
// protocol must produce the same wire.
export function recordMismatch(record, wire, commit) {
  if (record.releaseCommit !== commit) {
    return `The record for ${record.protocolVersion} names release commit ${record.releaseCommit ?? "(none)"}, but the package was built from ${commit}.`
  }
  if (record.protocolVersion !== wire.protocolVersion) {
    return `The record is for protocol ${record.protocolVersion}, but the package at its release commit is ${wire.protocolVersion}.`
  }
  const names = new Set([...Object.keys(record.schemas), ...Object.keys(wire.schemas)])
  const changed = [...names].sort().filter((name) => record.schemas[name] !== wire.schemas[name])
  if (changed.length === 0) return undefined
  return `The record for ${record.protocolVersion} differs from the wire built at its release commit: ${changed.join(", ")}.`
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
  const option = (name) => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] ?? "" : undefined
  }
  const packageRoot = option("--package") === undefined ? root : resolve(option("--package"))
  if (command === "record" || command === "verify") {
    const wire = await wireOf(packageRoot)
    const releaseCommit = git(packageRoot, ["rev-parse", "HEAD"]).trim()
    const path = join(root, wireReleasesPath, `${wire.protocolVersion}.json`)
    if (command === "verify") {
      if (!existsSync(path)) {
        process.stderr.write(`No release record for protocol ${wire.protocolVersion} in ${wireReleasesPath}.\n`)
        return 1
      }
      const mismatch = recordMismatch(JSON.parse(readFileSync(path, "utf8")), wire, releaseCommit)
      if (mismatch) {
        process.stderr.write(`${mismatch}\n`)
        return 1
      }
      process.stdout.write(`The record for protocol ${wire.protocolVersion} matches its release commit ${releaseCommit}.\n`)
      return 0
    }
    mkdirSync(join(root, wireReleasesPath), { recursive: true })
    if (existsSync(path) && !rest.includes("--replace")) {
      process.stderr.write(`${path} exists; a release record is written once. Pass --replace to rewrite it.\n`)
      return 1
    }
    writeFileSync(path, `${JSON.stringify({ protocolVersion: wire.protocolVersion, releaseCommit, schemas: wire.schemas }, null, 2)}\n`)
    process.stdout.write(`Recorded the wire of protocol ${wire.protocolVersion} from ${releaseCommit}.\n`)
    return 0
  }
  if (command !== "check") {
    process.stderr.write("Usage: node scripts/protocol-wire.mjs check [--base <sha>] | record [--package <root>] [--replace] | verify [--package <root>]\n")
    return 2
  }
  const base = option("--base")
  if (base === undefined && process.env.CI) {
    process.stderr.write("In CI, check needs --base <full base commit SHA>, so a rewritten release record cannot pass.\n")
    return 1
  }
  if (base !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(base)) {
      process.stderr.write("--base needs the full base commit SHA.\n")
      return 2
    }
    try {
      git(root, ["cat-file", "-e", `${base}^{commit}`])
    } catch {
      process.stderr.write(`--base ${base} cannot be resolved to a commit in this checkout.\n`)
      return 1
    }
    const refusal = releasedRecordRefusal(root, base)
    if (refusal) {
      process.stderr.write(`${refusal}\n`)
      return 1
    }
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
