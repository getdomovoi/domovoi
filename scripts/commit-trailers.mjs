import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Attribution belongs to the person who asked for the work, and a commit message
// is not the place to record which tool typed it. The rule was standing and
// written down; it was broken on 33 commits across one session because a harness
// instruction asked for the trailer and nobody checked the message against the
// rule before committing.
//
// What made that expensive was where it was caught. Fourteen of the 33 had
// already merged, and removing them meant rewriting published history, which
// dropped 314 commit signatures that cannot be restored. The signatures were the
// price of the violation rather than of the fix: a trailer caught before the
// commit costs one rejected message, and the same trailer caught after a merge
// costs the repository's history.
//
// So this runs on the range, not on the tip, and it runs in CI where no local
// setup can be missing. The commit-msg hook under .githooks says the same thing
// a second earlier; it is the convenience and this is the gate.
export const forbiddenTrailers = [
  { name: "Claude-Session", pattern: /^\s*Claude-Session\s*:/i },
  { name: "Co-Authored-By an assistant", pattern: /^\s*Co-Authored-By\s*:.*\b(claude|copilot|cursor|codex|chatgpt|gpt-[0-9])\b/i },
  { name: "Generated-By", pattern: /^\s*(Generated|Authored)-(By|With)\s*:/i },
  { name: "an assistant session link", pattern: /^\s*(https?:\/\/)?(claude\.ai\/code\/session_|chat\.openai\.com\/)/i },
]

// The harness appends the trailer on its own, so a hook that only rejects turns
// every commit into an amend — a treadmill rather than a fix. The local hook
// strips instead, and says what it removed; the CI gate still refuses, because
// it is the thing that cannot be uninstalled. Removing a line nobody asked for
// is not hiding anything, and the notice is there so it stays visible.
export function withoutAttribution(message) {
  const removed = []
  const kept = []
  for (const line of message.split("\n")) {
    const hit = forbiddenTrailers.find(({ pattern }) => pattern.test(line))
    if (hit) removed.push({ name: hit.name, text: line.trim() })
    else kept.push(line)
  }
  // Dropping a trailer leaves the blank line that separated it from the body.
  while (kept.length > 1 && kept.at(-1) === "" && kept.at(-2) === "") kept.pop()
  return { message: `${kept.join("\n").replace(/\n+$/, "")}\n`, removed }
}

export function offendingLines(message) {
  const found = []
  for (const [index, line] of message.split("\n").entries()) {
    for (const { name, pattern } of forbiddenTrailers) {
      if (pattern.test(line)) found.push({ line: index + 1, name, text: line.trim() })
    }
  }
  return found
}

// Fail closed. The first version of this returned ok on every git failure, which
// is the exact defect scripts/tick-citations.mjs had and had already been fixed
// for: a gate that cannot see the range says so instead of passing. Found by
// CodeRabbit on the pull request that introduced it, one week after the same
// bug was removed from the other checker.
//
// The second version fell back from origin/main to main on any error, not only
// on absence, so a read failure on the remote ref quietly narrowed the range to
// what local main could see. With --quiet, git exits 1 for a ref that does not
// exist and something else for a ref it could not read; only the first is a
// reason to try the next candidate.
export async function baseRef(git) {
  // On a branch, every commit this branch adds. On main, the tip alone: rewriting
  // what is already published is the thing this check exists to make unnecessary.
  for (const candidate of ["origin/main", "main"]) {
    let base
    try {
      base = await git(["rev-parse", "--verify", "--quiet", candidate])
    } catch (error) {
      if (error.code === 1) continue
      throw error
    }
    const head = await git(["rev-parse", "HEAD"])
    if (head !== base) return { range: `${candidate}..HEAD`, named: candidate }
    return { range: "HEAD~1..HEAD", named: candidate }
  }
  return undefined
}

const unverifiable = (reason) => ({
  ok: false,
  checked: 0,
  failures: [`cannot check commit messages: ${reason}. Fetch full history — in CI that is actions/checkout with fetch-depth: 0.`],
})

export async function checkCommitTrailers(root = repositoryRoot) {
  const git = async (args) => (await run("git", args, { cwd: root })).stdout.trim()
  // A shallow clone cannot enumerate the branch, so every commit before the
  // graft point is unchecked while the run still goes green.
  try {
    if ((await git(["rev-parse", "--is-shallow-repository"])) === "true") {
      return unverifiable("this is a shallow clone")
    }
  } catch (error) {
    return unverifiable(`git could not answer whether this is a shallow clone (${error.code ?? "failed"})`)
  }
  let base
  try {
    base = await baseRef(git)
  } catch (error) {
    return unverifiable(`git could not resolve a base to compare against (${error.code ?? "failed"})`)
  }
  if (!base) return unverifiable("neither origin/main nor main exists to compare against")
  let shas
  try {
    shas = (await git(["rev-list", base.range])).split("\n").filter(Boolean)
  } catch (error) {
    return unverifiable(`git could not list ${base.range} (${error.code ?? "failed"})`)
  }
  const failures = []
  for (const sha of shas) {
    const message = (await run("git", ["log", "-1", "--format=%B", sha], { cwd: root })).stdout
    for (const { line, name, text } of offendingLines(message)) {
      failures.push(`${sha.slice(0, 7)} message line ${line}: ${name} is not allowed in a commit message.\n    ${text}`)
    }
  }
  return { ok: failures.length === 0, failures, checked: shas.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { ok, failures, checked } = await checkCommitTrailers()
  if (ok) {
    process.stdout.write(`no assistant attribution in ${checked} commit message${checked === 1 ? "" : "s"}\n`)
  } else {
    process.stdout.write(`${failures.join("\n")}\n\nRewrite the message with \`git commit --amend\` or \`git rebase -i\`. A trailer that reaches main cannot be removed without rewriting published history, which destroys commit signatures.\n`)
    process.exitCode = 1
  }
}
