import { join } from "node:path"

// How the daemon runs Git for its own bookkeeping, shared by workspace.ts and
// the repository git filter reader so both read the configuration Git applies.

// Daemon bookkeeping is not the person's own Git work. A relative
// core.hooksPath resolves inside the session worktree, where the agent can
// write, so every command points hooks at a path that can never be a directory.
const inertHooksPath = process.platform === "win32" ? join(process.execPath, "hooks") : "/dev/null"
export const inertRepositoryConfig = ["-c", `core.hooksPath=${inertHooksPath}`, "-c", "core.fsmonitor=false"] as const

// Config and helpers the daemon's own environment carries are not the
// repository's and not the person's config files: an inherited
// GIT_CONFIG_COUNT would add filters the scope scan reads as command-line
// settings, GIT_CONFIG would point the scan at another file than the one add
// and checkout read, GIT_CONFIG_GLOBAL could name a worktree file as "global",
// and GIT_DIR or GIT_INDEX_FILE would point a command at another repository.
// Daemon git runs without them, so "global" and "system" are git's own files
// for this user.
const droppedGitEnvironment = new Set([
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
])

export function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase()
    if (droppedGitEnvironment.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(upper)) continue
    environment[name] = value
  }
  return environment
}

// A filter driver runs a command on every add, checkout and reset. One the
// person set in their global or system config is their own tool (Git LFS). One
// the repository's own config sets can point at a file the agent edits, and
// switching it off would change what a checkpoint stores (git-crypt plaintext),
// so the actions that would run it are refused unless the repository is
// trusted on this machine, and then run only its reviewed definitions
// (repository-git-filter-gate.ts).
// "unknown" is config git ships itself, such as Apple Git's credential helper.
// "command" is left out: the daemon's own -c settings name no filter or
// helper, and an inherited one is dropped with the environment above.
export const trustedConfigScopes: ReadonlySet<string> = new Set(["system", "global", "unknown"])
