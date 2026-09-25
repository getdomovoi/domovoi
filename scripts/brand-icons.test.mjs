import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { chromiumArgs, findChromium, markPage, render, targets } from "./brand-icons.mjs"

const scratch = join(tmpdir(), "domovoi-icon-test", "page dir")
const html = join(scratch, "page.html")
const shot = join(scratch, "shot.png")

test("the browser stays on the temporary profile headless mode creates", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  // A named profile would be a real one, and a fresh explicit one hangs Brave before the shot.
  assert.equal(args.some((arg) => /^--(user-data-dir|profile-directory)=/.test(arg)), false)
  assert.equal(args[0], "--headless=new")
})

test("the browser cannot reach the network while it renders", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  // Every host fails to resolve, so a background service cannot fetch even if it starts.
  assert.ok(args.includes("--host-resolver-rules=MAP * ~NOTFOUND"))
  // An address literal skips the resolver, so traffic also goes to a proxy on a closed port.
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:9"))
  for (const flag of [
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
})

test("the page is addressed by a file URL that survives spaces and Windows paths", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  assert.equal(args.at(-1), pathToFileURL(html).href)
})

test("every page inlines the mark and loads nothing from a host", () => {
  for (const target of targets) {
    const page = markPage({ size: target.size, ...target.page })
    assert.doesNotMatch(page, /\b(?:https?|wss?|ftp):/i, target.out)
    assert.match(page, /url\("data:image\/svg\+xml;base64,/, target.out)
  }
})

test("a directory is not taken for a browser executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-dir-"))
  try {
    assert.equal(findChromium([directory, process.execPath]), process.execPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a missing browser names every path it tried", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-missing-"))
  try {
    const missing = join(directory, "no-such-browser")
    assert.throws(() => findChromium([missing]), (error) => error.message.includes(missing))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Node stands in for the browser on every platform: `--` hands the browser arguments to the
// stand-in script instead of letting Node parse them as its own options.
function standIn(source) {
  return { file: process.execPath, args: ["-e", source, "--"] }
}

test("a browser that fails leaves no scratch files and writes no asset", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-render-"))
  try {
    const scratchRoot = join(directory, "scratch")
    const out = join(directory, "out", "icon.png")
    assert.throws(() =>
      render("<p>page</p>", 16, out, { browser: standIn("process.exit(3)"), scratchRoot }),
    )
    assert.deepEqual(readdirSync(scratchRoot), [])
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a browser that hangs is stopped at the render time limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-render-"))
  try {
    const scratchRoot = join(directory, "scratch")
    const out = join(directory, "out", "icon.png")
    const started = Date.now()
    assert.throws(
      () =>
        render("<p>page</p>", 16, out, {
          browser: standIn("setInterval(() => {}, 1000)"),
          scratchRoot,
          timeoutMs: 500,
        }),
      /ETIMEDOUT|timed out/i,
    )
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual(readdirSync(scratchRoot), [])
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
