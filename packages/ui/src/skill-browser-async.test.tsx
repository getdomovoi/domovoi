import type { ReactElement, ReactNode } from "react"
import { isValidElement } from "react"
import { describe, expect, it, vi } from "vitest"

import type { SkillDocument, SkillSummary } from "@getdomovoi/protocol"

const hookHarness = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[],
}))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => {
      const index = hookHarness.index++
      if (!(index in hookHarness.values)) hookHarness.values[index] = { current: initial }
      return hookHarness.values[index] as { current: T }
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hookHarness.index++
      if (!(index in hookHarness.values)) {
        hookHarness.values[index] = typeof initial === "function"
          ? (initial as () => T)()
          : initial
      }
      const setValue = (next: T | ((current: T) => T)) => {
        hookHarness.values[index] = typeof next === "function"
          ? (next as (current: T) => T)(hookHarness.values[index] as T)
          : next
      }
      return [hookHarness.values[index] as T, setValue] as const
    },
  }
})

import { SkillBrowser, SkillSourceContent } from "./skill-browser"

const skillSecurityMetadata = {
  manifest: { version: 1 as const, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" as const },
  trust: { state: "untrusted" as const, reason: "unsigned" as const },
}

const skills: SkillSummary[] = [
  {
    id: "skill-111111111111",
    name: "design-studio",
    description: "Create full-fidelity design variants.",
    path: "/home/dev/.agents/skills/design-studio/SKILL.md",
    scope: "user",
    source: "agents",
    ...skillSecurityMetadata,
  },
  {
    id: "skill-222222222222",
    name: "repo-audit",
    description: "Audit repository quality and risk.",
    path: "/repo/.agents/skills/repo-audit/SKILL.md",
    scope: "project",
    source: "agents",
    ...skillSecurityMetadata,
  },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function childrenOf(element: ReactElement): ReactNode {
  return (element.props as { children?: ReactNode }).children
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (!isValidElement(node)) return ""
  return textOf(childrenOf(node))
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement(node)) return undefined
  if (predicate(node)) return node
  return findElement(childrenOf(node), predicate)
}

describe("skill browser source requests", () => {
  it("keeps skill B source when deferred skill A resolves last", async () => {
    hookHarness.index = 0
    hookHarness.values.length = 0
    const skillA = deferred<SkillDocument>()
    const skillB = deferred<SkillDocument>()
    const onReadSkill = vi.fn((id: string) => (
      id === skills[0]!.id ? skillA.promise : skillB.promise
    ))
    const props = {
      skills,
      loading: false,
      error: "",
      onBack: vi.fn(),
      onOpenAudit: vi.fn(),
      onReadSkill,
      projectId: "project-acme-api",
      enablements: [],
      onSetSkillEnabled: vi.fn(),
      onReviewSkill: vi.fn(),
      onRetry: vi.fn(),
    }
    const renderBrowser = () => {
      hookHarness.index = 0
      return SkillBrowser(props)
    }
    const click = (tree: ReactElement, label: string) => {
      const target = findElement(tree, (element) => {
        const onClick = (element.props as { onClick?: unknown }).onClick
        return typeof onClick === "function" && textOf(element).startsWith(label)
      })
      expect(target, `clickable ${label}`).toBeDefined()
      ;(target!.props as { onClick: () => void }).onClick()
    }
    const sourceProps = (tree: ReactElement) => {
      const source = findElement(tree, (element) => element.type === SkillSourceContent)
      expect(source).toBeDefined()
      return source!.props as Parameters<typeof SkillSourceContent>[0]
    }

    click(renderBrowser(), "View SKILL.md")
    click(renderBrowser(), "repo-audit")
    click(renderBrowser(), "View SKILL.md")

    skillB.resolve({ skill: skills[1]!, content: "source B" })
    await Promise.resolve()
    await Promise.resolve()
    expect(sourceProps(renderBrowser())).toMatchObject({
      skill: skills[1],
      content: "source B",
      loading: false,
    })

    skillA.resolve({ skill: skills[0]!, content: "source A" })
    await Promise.resolve()
    await Promise.resolve()
    expect(sourceProps(renderBrowser())).toMatchObject({
      skill: skills[1],
      content: "source B",
      loading: false,
    })
  })
})
