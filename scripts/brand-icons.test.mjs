import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { chromiumArgs, findChromium, markPage, targets } from "./brand-icons.mjs"

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
  assert.throws(() => findChromium([join(tmpdir(), "domovoi-no-such-browser")]), /domovoi-no-such-browser/)
})
