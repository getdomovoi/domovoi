import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  checkRoadmapHtml,
  parseMarkdown,
  renderBody,
  renderInline,
  renderRoadmapHtml,
  renderToc,
  slugify,
  writeRoadmapHtml,
} from "./roadmap-html.mjs"

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-roadmap-"))
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(root, path), contents)
  }
  return root
}

function body(markdown) {
  return renderBody(parseMarkdown(markdown))
}

test("slugs match the heading ids the page has always used", () => {
  assert.equal(slugify("Goal 0: secure and bound the local core"), "goal-0-secure-and-bound-the-local-core")
  assert.equal(slugify("Completion-audit remediation ledger"), "completion-audit-remediation-ledger")
  assert.equal(slugify("Goal 3: ship hosted web, phone, and tablet control"), "goal-3-ship-hosted-web-phone-and-tablet-control")
  assert.equal(slugify("Post-MVP expansion"), "post-mvp-expansion")
})

test("renders headings with their level and id", () => {
  assert.equal(body("# Domovoi roadmap\n\n## Goal 0: secure and bound the local core\n\n### Skills\n"), [
    '<h1 id="domovoi-roadmap">Domovoi roadmap</h1>',
    '<h2 id="goal-0-secure-and-bound-the-local-core">Goal 0: secure and bound the local core</h2>',
    '<h3 id="skills">Skills</h3>',
    "",
  ].join("\n"))
})

test("keeps checkbox markers as literal text instead of reading them as links", () => {
  assert.equal(body("- [x] done\n- [ ] open\n"), [
    "<ul>",
    "<li>[x] done",
    "</li>",
    "<li>[ ] open",
    "</li>",
    "</ul>",
    "",
  ].join("\n"))
})

test("nests an ordered list under the bullet that introduces it", () => {
  assert.equal(body([
    "- [x] Implement one transport abstraction with this order:",
    "  1. loopback or OS-private IPC;",
    "  2. LAN connection;",
    "- [x] Authenticate every connection",
    "",
  ].join("\n")), [
    "<ul>",
    "<li>[x] Implement one transport abstraction with this order:",
    "<ol>",
    "<li>loopback or OS-private IPC;",
    "</li>",
    "<li>LAN connection;",
    "</li>",
    "</ol>",
    "</li>",
    "<li>[x] Authenticate every connection",
    "</li>",
    "</ul>",
    "",
  ].join("\n"))
})

test("renders a top-level ordered list", () => {
  assert.equal(body("1. **Guest hard gates:** whether guests may approve\n   migrations.\n2. **Support policy:** cadence.\n"), [
    "<ol>",
    "<li><strong>Guest hard gates:</strong> whether guests may approve migrations.",
    "</li>",
    "<li><strong>Support policy:</strong> cadence.",
    "</li>",
    "</ol>",
    "",
  ].join("\n"))
})

test("joins wrapped list items and nested items with a single space", () => {
  assert.equal(body([
    "- [x] Add a complete session history with filters for messages,",
    "  checkpoints, annotations, and tests",
    "  - A timed-out operation must not mutate state after the",
    "    serialized request has failed.",
    "- [x] Next item",
    "",
  ].join("\n")), [
    "<ul>",
    "<li>[x] Add a complete session history with filters for messages, checkpoints, annotations, and tests",
    "<ul>",
    "<li>A timed-out operation must not mutate state after the serialized request has failed.",
    "</li>",
    "</ul>",
    "</li>",
    "<li>[x] Next item",
    "</li>",
    "</ul>",
    "",
  ].join("\n"))
})

test("joins hard-wrapped paragraph lines and separates paragraphs on a blank line", () => {
  assert.equal(body("This roadmap turns the signed handoff into\nan ordered delivery plan.\n\nPriority: `P0`.\n"), [
    "<p>This roadmap turns the signed handoff into an ordered delivery plan.</p>",
    "<p>Priority: <code>P0</code>.</p>",
    "",
  ].join("\n"))
})

test("renders inline code without interpreting markup inside it", () => {
  assert.equal(renderInline("never through `\\\\wsl$` or `[x]` or `**bold**`"), "never through <code>\\\\wsl$</code> or <code>[x]</code> or <code>**bold**</code>")
})

test("renders bold spans", () => {
  assert.equal(renderInline("**Provider handoff disclosure:** required disclosure"), "<strong>Provider handoff disclosure:</strong> required disclosure")
})

test("renders absolute and relative links", () => {
  assert.equal(renderInline("[#94](https://github.com/getdomovoi/domovoi/pull/94) and [docs/licensing.md](docs/licensing.md)"), '<a href="https://github.com/getdomovoi/domovoi/pull/94">#94</a> and <a href="docs/licensing.md">docs/licensing.md</a>')
})

test("escapes HTML in text, code, and link targets", () => {
  assert.equal(renderInline("Fish & chips <b>not markup</b>"), "Fish &amp; chips &lt;b&gt;not markup&lt;/b&gt;")
  assert.equal(renderInline("`a < b && c`"), "<code>a &lt; b &amp;&amp; c</code>")
  assert.equal(renderInline('[q](https://x.test/?a=1&b=2)'), '<a href="https://x.test/?a=1&amp;b=2">q</a>')
})

test("builds the table of contents from second and third level headings only", () => {
  const blocks = parseMarkdown("# Domovoi roadmap\n\n## Goal 0: secure and bound the local core\n\n### Skills\n\n#### Deep\n")
  assert.equal(renderToc(blocks), '<details class="toc" open><summary>Contents</summary><ul><li class="lvl2"><a href="#goal-0-secure-and-bound-the-local-core">Goal 0: secure and bound the local core</a></li><li class="lvl3"><a href="#skills">Skills</a></li></ul></details>')
})

test("renders a full page with the title from the first heading and no timestamp", () => {
  const markdown = "# Domovoi roadmap\n\nIntro & more.\n\n## Current baseline\n\n- [x] done\n"
  const html = renderRoadmapHtml(markdown)
  assert.equal(html, renderRoadmapHtml(markdown))
  assert.ok(html.startsWith("<!doctype html>\n<html lang=\"en\">\n<head>\n"))
  assert.ok(html.includes("<title>Domovoi roadmap</title>"))
  assert.ok(html.includes("<style>\n:root {"))
  assert.ok(html.includes('<div class="meta">ROADMAP.md  ·  generated by scripts/roadmap-html.mjs</div>'))
  assert.ok(html.includes('<main class="doc">\n<h1 id="domovoi-roadmap">Domovoi roadmap</h1>\n<p>Intro &amp; more.</p>\n'))
  assert.ok(html.endsWith("</main>\n</div>\n</body>\n</html>\n"))
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
})

test("reports a stale ROADMAP.html and accepts a regenerated one", async (t) => {
  const root = await fixture({ "ROADMAP.md": "# Domovoi roadmap\n\n- [x] done\n" })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual(await checkRoadmapHtml(root), ["ROADMAP.html: missing; run pnpm roadmap:html"])

  await writeRoadmapHtml(root)
  assert.deepEqual(await checkRoadmapHtml(root), [])
  assert.equal(await readFile(join(root, "ROADMAP.html"), "utf8"), renderRoadmapHtml("# Domovoi roadmap\n\n- [x] done\n"))

  await writeFile(join(root, "ROADMAP.md"), "# Domovoi roadmap\n\n- [ ] done\n")
  assert.deepEqual(await checkRoadmapHtml(root), ["ROADMAP.html: stale relative to ROADMAP.md; run pnpm roadmap:html"])
})
