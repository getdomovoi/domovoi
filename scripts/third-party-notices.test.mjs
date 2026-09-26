import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { collectDesktopNotices, readNoticeTexts, renderThirdPartyNotices } from "./third-party-notices.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))

test("renders each shipped package with its declared license and the files it publishes", () => {
  const text = renderThirdPartyNotices([
    { name: "fixture", version: "1.0.0", license: "Apache-2.0", texts: [
      { file: "LICENSE", text: "Apache License text" },
      { file: "NOTICE", text: "Fixture notice" },
    ] },
  ])
  assert.match(text, /^fixture@1\.0\.0$/mu)
  assert.match(text, /^License: Apache-2\.0$/mu)
  assert.match(text, /--- LICENSE ---\nApache License text/u)
  assert.match(text, /--- NOTICE ---\nFixture notice/u)
})

test("says so when a package publishes no license file instead of leaving it out", () => {
  const text = renderThirdPartyNotices([{ name: "bare", version: "2.0.0", license: "MIT", texts: [] }])
  assert.match(text, /^bare@2\.0\.0$/mu)
  assert.match(text, /publishes no license or notice file/u)
})

test("reads license, licence, copying and notice files, and nothing else", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-notices-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [file, text] of [["LICENSE.md", "license"], ["NOTICE", "notice"], ["LICENCE-MIT", "licence"], ["COPYING", "copying"], ["README.md", "readme"], ["license-checker.js", "code"]]) {
    await writeFile(join(directory, file), text)
  }
  assert.deepEqual((await readNoticeTexts(directory)).map((entry) => entry.file), ["COPYING", "LICENCE-MIT", "LICENSE.md", "NOTICE"])
})

test("the desktop notices carry the renderer fonts' license and leave out the agent binaries the app excludes", { timeout: 60_000 }, async () => {
  const entries = await collectDesktopNotices(root)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  for (const font of ["@fontsource-variable/instrument-sans", "@fontsource-variable/jetbrains-mono"]) {
    assert.match(byName.get(font)?.texts.map((entry) => entry.text).join("\n") ?? "", /SIL Open Font License/u, `${font} carries its OFL text`)
  }
  assert.ok(byName.has("electron"), "the Electron runtime is named")
  assert.ok(byName.has("react-dom"), "the renderer graph is named")
  assert.ok(byName.has("@anthropic-ai/claude-agent-sdk"), "the bundled SDK library is named")
  assert.deepEqual(entries.filter((entry) => entry.name.startsWith("@anthropic-ai/claude-agent-sdk-")), [])
  assert.deepEqual(entries.filter((entry) => entry.name.startsWith("@getdomovoi/")), [], "first-party packages are not third-party")
})
