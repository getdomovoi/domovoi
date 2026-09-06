import { execFileSync } from "node:child_process"

// Asking Windows where pnpm lives is a bare process spawn, and a cold runner
// stalls one for many seconds: CI runs 34014680315 and 34012487331 both killed
// where.exe at a fixed 10000 ms bound within an hour of each other. This bound
// is not how long the question takes, it is how long a stalled machine may hold
// the answer back before waiting stops being worth it, so it is sized past the
// stalls that have been measured here. Unlike the bound it replaces it is not
// fatal: a lookup that runs out hands back the bare name, which Windows
// resolves from PATH to the same executable the lookup would have named.
export const windowsLookupTimeoutMs = 60_000

const scriptLauncher = /\.[cm]?js$/iu
const shimLauncher = /\.(?:cmd|bat|ps1)$/iu
const pnpmLauncher = /^pnpm(\.|$)/iu

const lastSegment = (path) => path.split(/[\\/]/u).pop() ?? ""

// pnpm publishes its own executable in npm_execpath, so every caller reached
// through a pnpm script already carries the answer a lookup would spawn a
// process to rediscover. npm and yarn publish theirs in the same variable and
// neither understands the --filter invocation these callers build, so a
// launcher that is not pnpm is ignored rather than trusted. Node refuses to
// spawn a .cmd or .bat without a shell, and a shell is what mangled the
// packing paths this module exists to keep intact, so a shim is left to the
// lookup instead of becoming a spawn EINVAL inside a pack.
function launcherInvocation(env) {
  const launcher = env.npm_execpath
  if (!launcher || !pnpmLauncher.test(lastSegment(launcher))) return undefined
  if (scriptLauncher.test(launcher)) return { command: env.npm_node_execpath || process.execPath, args: [launcher] }
  return shimLauncher.test(launcher) ? undefined : { command: launcher, args: [] }
}

const windowsLookup = () => execFileSync("where.exe", ["pnpm.exe"], {
  encoding: "utf8", timeout: windowsLookupTimeoutMs, killSignal: "SIGKILL",
})

function lookupInvocation(lookup) {
  let printed
  try {
    printed = lookup()
  } catch (cause) {
    // A lookup that answers, even to say no, has told us pnpm.exe is absent and
    // the bare name would only find a .cmd shim that Node refuses to spawn. A
    // lookup that never answers has told us nothing about PATH, so the name is
    // still worth trying and the reason for trying it is said out loud.
    if (cause.code !== "ETIMEDOUT") throw missingPnpm(cause.message, cause)
    console.warn(`where.exe did not name pnpm.exe within ${windowsLookupTimeoutMs} ms; running pnpm by name and`
      + " letting Windows resolve it from PATH")
    return { command: "pnpm", args: [] }
  }

  const [executable] = printed.trim().split(/\r?\n/u)
  if (!executable) throw missingPnpm("where.exe printed no path")
  return { command: executable, args: [] }
}

function missingPnpm(reason, cause) {
  return new Error(`where.exe found no pnpm.exe on PATH, so packing cannot run pnpm: ${reason}`, { cause })
}

export function pnpmInvocation(platform = process.platform, { env = process.env, lookup = windowsLookup } = {}) {
  if (platform !== "win32") return { command: "pnpm", args: [], shell: false }
  return { ...launcherInvocation(env) ?? lookupInvocation(lookup), shell: false }
}
