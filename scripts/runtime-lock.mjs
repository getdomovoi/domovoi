import { posix } from "node:path"

const protocolName = "@getdomovoi/protocol"
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const namePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/
const maximumNodes = 10_000

function insist(condition, message) {
  if (!condition) throw new Error(`Runtime lock: ${message}`)
}

function versionFromReference(reference) {
  const version = reference.split("(", 1)[0]
  insist(versionPattern.test(version), `unsupported workspace or registry reference ${reference}`)
  return version
}

function integrityFor(value, name) {
  insist(typeof value === "string" && integrityPattern.test(value), `missing SHA512 integrity for ${name}`)
  return value
}

const sortedEntries = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))

// Root install metadata deliberately omits development dependencies and release
// lifecycle hooks. npm ci still validates omitted dev dependencies, so copying
// the published library manifest here would require freezing the build graph too.
export function daemonRuntimeManifest(manifest, protocolManifest, lock) {
  const result = { name: manifest.name, version: manifest.version, private: true }
  insist(manifest.name === "@getdomovoi/daemon" && protocolManifest.name === protocolName,
    "unexpected first-party package")
  insist(versionPattern.test(manifest.version) && manifest.version === protocolManifest.version,
    "daemon and protocol must share an exact release version")
  for (const field of ["type", "license", "engines", "bin", "main", "types", "exports"]) {
    if (manifest[field] !== undefined) result[field] = manifest[field]
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (!manifest[field]) continue
    result[field] = Object.fromEntries(sortedEntries(manifest[field]).map(([name, specifier]) => {
      if (specifier === "workspace:*" && name === protocolName) return [name, protocolManifest.version]
      if (specifier.startsWith("catalog:")) {
        const catalog = specifier.slice("catalog:".length) || "default"
        const resolved = lock.catalogs?.[catalog]?.[name]?.specifier
        insist(typeof resolved === "string", `missing catalog ${catalog}.${name}`)
        return [name, resolved]
      }
      insist(!/^(workspace|link|file|portal):/.test(specifier), `unsupported workspace dependency ${name}`)
      return [name, specifier]
    }))
  }
  insist(!manifest.peerDependencies, "root peer dependencies need an explicit runtime policy")
  return result
}

export function daemonRuntimeLock({ manifest, protocolManifest, protocolIntegrity, lock }) {
  insist(String(lock.lockfileVersion) === "9.0", "unsupported pnpm lockfile version")
  const runtime = daemonRuntimeManifest(manifest, protocolManifest, lock)
  const protocolKey = `${protocolName}@${protocolManifest.version}`
  const definitions = new Map()

  function importer(name, source) {
    const record = lock.importers?.[name]
    insist(record, `missing workspace importer ${name}`)
    const edges = []
    for (const field of ["dependencies", "optionalDependencies"]) {
      const declared = source[field] ?? {}
      insist(JSON.stringify(Object.keys(declared).sort()) === JSON.stringify(Object.keys(record[field] ?? {}).sort()),
        `stale ${name}.${field}`)
      for (const [child, specifier] of sortedEntries(declared)) {
        const resolved = record[field]?.[child]
        insist(resolved?.specifier === specifier, `stale ${name}.${child}`)
        edges.push({ name: child, key: define(child, resolved.version), optional: field === "optionalDependencies" })
      }
    }
    return edges
  }

  function define(name, reference) {
    insist(namePattern.test(name) && ![".", "..", "node_modules"].includes(name), `invalid package name ${name}`)
    if (reference.startsWith("link:")) {
      insist(name === protocolName && reference === "link:../../packages/protocol", `unknown workspace link ${name}: ${reference}`)
      if (!definitions.has(protocolKey)) {
        const info = { version: protocolManifest.version, resolved: "file:runtime/protocol.tgz", integrity: integrityFor(protocolIntegrity, name) }
        const definition = { name, info, edges: [] }
        definitions.set(protocolKey, definition)
        definition.edges = importer("packages/protocol", protocolManifest)
      }
      return protocolKey
    }
    const version = versionFromReference(reference)
    const key = `${name}@${reference}`
    if (definitions.has(key)) return key
    insist(definitions.size < maximumNodes, `graph exceeds ${maximumNodes} nodes`)
    const metadata = lock.packages?.[`${name}@${version}`]
    const snapshot = lock.snapshots?.[key]
    insist(metadata && snapshot, `missing graph node ${key}`)
    insist(!metadata.resolution.tarball, `custom tarball resolution requires review for ${key}`)
    const info = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
      integrity: integrityFor(metadata.resolution?.integrity, key),
    }
    for (const field of ["os", "cpu", "libc", "engines"]) {
      if (metadata[field] !== undefined) info[field] = metadata[field]
    }
    const definition = { name, info, edges: [] }
    definitions.set(key, definition)
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [child, target] of sortedEntries(snapshot[field])) {
        definition.edges.push({ name: child, key: define(child, target), optional: field === "optionalDependencies" })
      }
    }
    return key
  }

  const roots = importer("apps/daemon", manifest)
  const required = new Set()
  function requireNode(key) {
    if (required.has(key)) return
    required.add(key)
    for (const edge of definitions.get(key).edges) if (!edge.optional) requireNode(edge.key)
  }
  for (const edge of roots) if (!edge.optional) requireNode(edge.key)

  const placements = new Map()
  const queue = []
  function place(path, key) {
    insist(placements.size < maximumNodes, `install layout exceeds ${maximumNodes} nodes`)
    const old = placements.get(path)
    if (old) { insist(old === key, `conflicting root ${path}`); return }
    placements.set(path, key)
    queue.push(path)
  }
  // Place every root first. Later hoisting cannot shadow a root declaration.
  for (const edge of roots) place(`node_modules/${edge.name}`, edge.key)
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    for (const edge of definitions.get(placements.get(path)).edges) {
      const found = resolveRuntimeDependency(path, edge.name, Object.fromEntries(placements))
      if (found && placements.get(found) === edge.key) continue
      const root = `node_modules/${edge.name}`
      // Conflicts stay immediately below their consumer, never in a partly
      // populated ancestor where they could change an earlier edge's meaning.
      place(placements.has(root) ? `${path}/node_modules/${edge.name}` : root, edge.key)
    }
  }
  const packages = { "": runtime }
  for (const [path, key] of sortedEntries(Object.fromEntries(placements))) {
    const definition = definitions.get(key)
    const entry = { ...definition.info }
    if (!required.has(key)) entry.optional = true
    for (const [field, optional] of [["dependencies", false], ["optionalDependencies", true]]) {
      const edges = definition.edges.filter((edge) => edge.optional === optional)
      if (edges.length) entry[field] = Object.fromEntries(edges.map((edge) => [edge.name, definitions.get(edge.key).info.version]))
    }
    packages[path] = entry
  }
  // Checking all edges after layout construction catches a future hoisting
  // change that accidentally redirects an existing consumer to another version.
  for (const [path, key] of placements) {
    for (const edge of definitions.get(key).edges) {
      const resolved = resolveRuntimeDependency(path, edge.name, packages)
      insist(placements.get(resolved) === edge.key, `layout changed ${path} -> ${edge.name}`)
    }
  }
  return { name: runtime.name, version: runtime.version, lockfileVersion: 3, requires: true, packages }
}

export function resolveRuntimeDependency(from, name, packages) {
  let directory = from
  for (;;) {
    if (posix.basename(directory) !== "node_modules") {
      const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`
      if (Object.hasOwn(packages, candidate)) return candidate
    }
    if (!directory) return undefined
    const parent = posix.dirname(directory)
    directory = parent === "." ? "" : parent
  }
}
