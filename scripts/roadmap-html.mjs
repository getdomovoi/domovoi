import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const markdownFile = "ROADMAP.md"
const htmlFile = "ROADMAP.html"
const regenerateCommand = "pnpm roadmap:html"
const headingLine = /^(#{1,6})\s+(.+?)\s*$/
const listItemLine = /^(\s*)(?:[-*+]|(\d+)\.)\s+(.*)$/
const codeSpan = /`([^`]+)`/g
const linkSpan = /\[([^\]]+)\]\(([^)\s]+)\)/g
const boldSpan = /\*\*([^*]+)\*\*/g

const styleSheet = `:root {
  --bg: #000;
  --panel: #1a1a19;
  --panel2: #232321;
  --fg: #ffffff;
  --ink2: #c3c2b7;
  --muted: #8a8a80;
  --rule: #2e2e2c;
  --link: #3987e5;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
* { scrollbar-width: thin; scrollbar-color: #3a3a37 transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: #3a3a37;
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background: #55554f; background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }
.layout {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 6rem;
}
.meta {
  color: var(--muted);
  font-size: 0.8125rem;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.75rem;
  margin-bottom: 2rem;
}
details.toc {
  border: 1px solid var(--rule);
  background: var(--panel);
  border-radius: 10px;
  padding: 0.7rem 1rem;
  margin: 0 0 2.5rem;
  font-size: 0.8125rem;
}
details.toc > summary {
  cursor: pointer;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.6875rem;
}
details.toc ul { list-style: none; margin: 0.7rem 0 0; padding: 0; }
details.toc li { margin: 0.15rem 0; }
details.toc li.lvl3 { padding-left: 1rem; font-size: 0.75rem; color: var(--muted); }
details.toc a { color: var(--ink2); text-decoration: none; }
details.toc li.lvl3 a { color: var(--muted); }
details.toc a:hover { color: var(--link); text-decoration: underline; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; font-weight: 600; color: var(--fg); }
h1 { font-size: 26px; margin: 0 0 1rem; letter-spacing: -0.01em; }
h2 {
  font-size: 18px;
  margin: 40px 0 12px;
  padding-top: 16px;
  border-top: 1px solid var(--rule);
}
h3 { font-size: 15px; margin: 26px 0 8px; color: var(--ink2); }
h4 {
  font-size: 12px;
  margin: 20px 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
p { margin: 0 0 1.05rem; color: var(--ink2); }
ul, ol { margin: 0 0 1.05rem; padding-left: 1.4rem; }
li { margin: 0.3rem 0; color: var(--ink2); }
li > ul, li > ol { margin: 0.3rem 0 0.4rem; }
a { color: var(--link); }
strong { font-weight: 600; color: var(--fg); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }
blockquote {
  margin: 0 0 1.05rem;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 10px;
  color: var(--ink2);
}
blockquote p:last-child { margin-bottom: 0; }
code {
  font-family: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 0.875em;
  background: var(--panel2);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0.05em 0.3em;
  overflow-wrap: break-word;
}
pre {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 0 0 1.25rem;
  line-height: 1.5;
}
pre code {
  background: none;
  border: 0;
  padding: 0;
  font-size: 12.5px;
  white-space: pre;
}
.tw { overflow-x: auto; margin: 12px 0 22px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { border-bottom: 1px solid var(--rule); padding: 7px 10px; vertical-align: top; }
th {
  background: none;
  font-weight: 600;
  white-space: nowrap;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 12px;
}
td { color: var(--ink2); }
@media (min-width: 1180px) {
  .layout {
    max-width: 74rem;
    display: grid;
    grid-template-columns: 15rem minmax(0, 46rem);
    gap: 3.5rem;
    align-items: start;
    padding-top: 3rem;
  }
  .layout > .doc { min-width: 0; }
  .side {
    position: sticky;
    top: 3rem;
    max-height: calc(100vh - 6rem);
    overflow-y: auto;
  }
  .meta { border-bottom: 0; margin-bottom: 0; }
  details.toc {
    background: none;
    border: 0;
    border-radius: 0;
    border-left: 1px solid var(--rule);
    padding: 0 0 0 1rem;
    margin: 1rem 0 0;
  }
  details.toc > summary { display: none; }
  details.toc ul { margin-top: 0; }
}
@media print {
  details.toc { display: none; }
  body { background: #fff; color: #000; font-size: 11pt; }
  p, li, td { color: #000; }
  pre, .tw { break-inside: avoid; }
}
`

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export function renderInline(text) {
  return text
    .split(codeSpan)
    .map((segment, index) => {
      if (index % 2 === 1) return `<code>${escapeHtml(segment)}</code>`
      return escapeHtml(segment)
        .replace(linkSpan, '<a href="$2">$1</a>')
        .replace(boldSpan, "<strong>$1</strong>")
    })
    .join("")
}

export function parseMarkdown(markdown) {
  const blocks = []
  const openLists = []
  let paragraph

  const flushParagraph = () => {
    if (paragraph) blocks.push({ type: "paragraph", text: paragraph.join(" ") })
    paragraph = undefined
  }
  const closeLists = () => {
    openLists.length = 0
  }
  const currentItem = () => openLists.at(-1).list.items.at(-1)

  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim() === "") {
      flushParagraph()
      closeLists()
      continue
    }

    const heading = headingLine.exec(line)
    if (heading) {
      flushParagraph()
      closeLists()
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] })
      continue
    }

    const item = listItemLine.exec(line)
    if (item) {
      flushParagraph()
      const indent = item[1].length
      const ordered = item[2] !== undefined
      while (openLists.length > 0 && openLists.at(-1).indent > indent) openLists.pop()
      const top = openLists.at(-1)
      if (top && top.indent === indent && top.list.ordered !== ordered) openLists.pop()
      const sibling = openLists.at(-1)
      if (sibling && sibling.indent === indent) {
        sibling.list.items.push({ text: item[3], children: [] })
        continue
      }
      const list = { type: "list", ordered, items: [{ text: item[3], children: [] }] }
      if (sibling) currentItem().children.push(list)
      else blocks.push(list)
      openLists.push({ list, indent })
      continue
    }

    if (openLists.length > 0) {
      const current = currentItem()
      current.text = `${current.text} ${line.trim()}`
      continue
    }
    paragraph ??= []
    paragraph.push(line.trim())
  }
  flushParagraph()
  return blocks
}

function renderList(list) {
  const tag = list.ordered ? "ol" : "ul"
  const items = list.items
    .map((item) => `<li>${renderInline(item.text)}\n${item.children.map(renderList).join("")}</li>\n`)
    .join("")
  return `<${tag}>\n${items}</${tag}>\n`
}

function renderBlock(block) {
  switch (block.type) {
    case "heading":
      return `<h${block.level} id="${slugify(block.text)}">${renderInline(block.text)}</h${block.level}>\n`
    case "paragraph":
      return `<p>${renderInline(block.text)}</p>\n`
    default:
      return renderList(block)
  }
}

export function renderBody(blocks) {
  return blocks.map(renderBlock).join("")
}

export function renderToc(blocks) {
  const entries = blocks
    .filter((block) => block.type === "heading" && (block.level === 2 || block.level === 3))
    .map((block) => `<li class="lvl${block.level}"><a href="#${slugify(block.text)}">${renderInline(block.text)}</a></li>`)
  return `<details class="toc" open><summary>Contents</summary><ul>${entries.join("")}</ul></details>`
}

export function renderRoadmapHtml(markdown) {
  const blocks = parseMarkdown(markdown)
  const title = blocks.find((block) => block.type === "heading" && block.level === 1)?.text ?? markdownFile
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${styleSheet}</style>`,
    "</head>",
    "<body>",
    '<div class="layout">',
    '<aside class="side">',
    `<div class="meta">${markdownFile}  ·  generated by scripts/roadmap-html.mjs</div>`,
    renderToc(blocks),
    "</aside>",
    '<main class="doc">',
    `${renderBody(blocks)}</main>`,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n")
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

export async function checkRoadmapHtml(root = repositoryRoot) {
  const markdown = await readFile(join(root, markdownFile), "utf8")
  const html = await readOptional(join(root, htmlFile))
  if (html === undefined) return [`${htmlFile}: missing; run ${regenerateCommand}`]
  if (html !== renderRoadmapHtml(markdown)) {
    return [`${htmlFile}: stale relative to ${markdownFile}; run ${regenerateCommand}`]
  }
  return []
}

export async function writeRoadmapHtml(root = repositoryRoot) {
  const markdown = await readFile(join(root, markdownFile), "utf8")
  await writeFile(join(root, htmlFile), renderRoadmapHtml(markdown))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) {
    const failures = await checkRoadmapHtml()
    for (const failure of failures) console.error(failure)
    if (failures.length > 0) process.exitCode = 1
  } else {
    await writeRoadmapHtml()
  }
}
