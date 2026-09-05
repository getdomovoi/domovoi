import type { ProviderPromptDelivery } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { PromptDeliveryNote } from "./prompt-delivery-note.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}` as const

type Skills = ProviderPromptDelivery["skills"]
type Context = Pick<ProviderPromptDelivery, "budget" | "annotations" | "handoff">

const noSkillOmissions: Skills["omitted"] = {
  budget: [],
  limit: [],
  unavailable: [],
  reviewChanged: [],
  policy: [],
}

function delivery(skills: Partial<Skills> = {}, context: Partial<Context> = {}): ProviderPromptDelivery {
  return {
    version: 1,
    budget: { unit: "utf16-code-units", limit: 262_144, used: 1_024 },
    handoff: { status: "not-required" },
    workingPlan: { status: "not-required" },
    annotations: { availableCount: 0, deliveredIds: [], omitted: { budget: 0, limit: 0 } },
    skills: { selection: "project-default", delivered: [], omitted: noSkillOmissions, ...skills },
    ...context,
  }
}

function lines(note: HTMLElement): (string | null)[] {
  return Array.from(note.children, (line) => line.textContent)
}

const names = { "skill-aaaaaaaaaaaa": "plan-preview", "skill-bbbbbbbbbbbb": "replay-audit" }

it("says nothing at all for a turn recorded before delivery was tracked", () => {
  const { container } = render(<PromptDeliveryNote delivery={undefined} skillNames={names} />)

  expect(container.innerHTML).toBe("")
})

it("names what was sent without claiming the provider used it", () => {
  render(<PromptDeliveryNote
    delivery={delivery({
      delivered: [{ id: "skill-aaaaaaaaaaaa", name: "plan-preview", contentDigest: digest, contentTruncated: false }],
    })}
    skillNames={names}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(note.textContent).toContain("Sent with plan-preview")
  expect(note.textContent).not.toMatch(/used|followed|applied/iu)
})

it("says whether each sent skill was trusted when the record knows", () => {
  render(<PromptDeliveryNote
    delivery={delivery({
      delivered: [
        {
          id: "skill-aaaaaaaaaaaa",
          name: "plan-preview",
          contentDigest: digest,
          contentTruncated: false,
          trust: { state: "trusted", reason: "verified-signature", authority: "signature · ed25519:0123456789abcdef" },
        },
        {
          id: "skill-bbbbbbbbbbbb",
          name: "replay-audit",
          contentDigest: digest,
          contentTruncated: false,
          trust: { state: "untrusted", reason: "unverified-signature" },
        },
        { id: "skill-cccccccccccc", name: "older", contentDigest: digest, contentTruncated: false },
      ],
    })}
    skillNames={{ ...names, "skill-cccccccccccc": "older" }}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(note.textContent).toContain("Sent with plan-preview (trusted), replay-audit (untrusted key), older")
  expect(note.textContent).not.toMatch(/used|followed|applied/iu)
})

it("separates a skill cut for space from one whose review changed", () => {
  render(<PromptDeliveryNote
    delivery={delivery({
      omitted: { ...noSkillOmissions, budget: ["skill-aaaaaaaaaaaa"], reviewChanged: ["skill-bbbbbbbbbbbb"] },
    })}
    skillNames={names}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(note.textContent).toContain("plan-preview omitted before send: no room in the prompt")
  expect(note.textContent).toContain("replay-audit omitted before send: its review changed")
})

it("stays quiet when a turn sent nothing and omitted nothing", () => {
  const { container } = render(<PromptDeliveryNote delivery={delivery()} skillNames={names} />)

  expect(container.innerHTML).toBe("")
})

it("falls back to the recorded id when the client has no name for it", () => {
  render(<PromptDeliveryNote
    delivery={delivery({ omitted: { ...noSkillOmissions, budget: ["skill-cccccccccccc"] } })}
    skillNames={names}
  />)

  expect(screen.getByRole("note", { name: "Prompt delivery" }).textContent).toContain("skill-cccccccccccc")
})

it("reports every trimmed source in the documented drop order", () => {
  render(<PromptDeliveryNote
    delivery={delivery(
      { omitted: { ...noSkillOmissions, budget: ["skill-aaaaaaaaaaaa"] } },
      {
        budget: { unit: "utf16-code-units", limit: 262_144, used: 200_000 },
        annotations: { availableCount: 3, deliveredIds: [], omitted: { budget: 2, limit: 1 } },
        handoff: { status: "delivered", omitted: { threadItems: 3, annotations: 2, artifacts: 1 } },
      },
    )}
    skillNames={names}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(lines(note)).toEqual([
    "plan-preview omitted before send: no room in the prompt",
    "2 open annotations were trimmed to fit the prompt budget",
    "1 open annotation was over the per-turn limit",
    "3 older thread items, 2 annotations, and 1 artifact from the handoff context were trimmed to fit the prompt",
  ])
  expect(note.title).toBe("Prompt used 200k of 262k code units")
  expect(note.textContent).not.toMatch(/[—!]/u)
})

it("uses the singular when one handoff item was trimmed", () => {
  render(<PromptDeliveryNote
    delivery={delivery({}, {
      annotations: { availableCount: 1, deliveredIds: [], omitted: { budget: 1, limit: 0 } },
      handoff: { status: "delivered", omitted: { threadItems: 1, annotations: 0, artifacts: 0 } },
    })}
    skillNames={names}
  />)

  expect(lines(screen.getByRole("note", { name: "Prompt delivery" }))).toEqual([
    "1 open annotation was trimmed to fit the prompt budget",
    "1 older thread item from the handoff context was trimmed to fit the prompt",
  ])
})

it("renders only the skill line when nothing else was trimmed", () => {
  render(<PromptDeliveryNote
    delivery={delivery(
      { omitted: { ...noSkillOmissions, budget: ["skill-aaaaaaaaaaaa"] } },
      {
        annotations: { availableCount: 2, deliveredIds: ["ann-1", "ann-2"], omitted: { budget: 0, limit: 0 } },
        handoff: { status: "delivered", omitted: { threadItems: 0, annotations: 0, artifacts: 0 } },
      },
    )}
    skillNames={names}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(lines(note)).toEqual(["plan-preview omitted before send: no room in the prompt"])
  expect(note.textContent).not.toMatch(/trimmed|handoff|annotation/u)
})

it("states the budget without inventing a drop when nothing was trimmed", () => {
  render(<PromptDeliveryNote
    delivery={delivery(
      { delivered: [{ id: "skill-aaaaaaaaaaaa", name: "plan-preview", contentDigest: digest, contentTruncated: false }] },
      { handoff: { status: "delivered", omitted: { threadItems: 0, annotations: 0, artifacts: 0 } } },
    )}
    skillNames={names}
  />)

  const note = screen.getByRole("note", { name: "Prompt delivery" })
  expect(lines(note)).toEqual(["Sent with plan-preview"])
  expect(note.title).toBe("Prompt used 1k of 262k code units")
})

it("stays quiet when a delivered handoff dropped nothing and no skills were involved", () => {
  const { container } = render(<PromptDeliveryNote
    delivery={delivery({}, { handoff: { status: "delivered", omitted: { threadItems: 0, annotations: 0, artifacts: 0 } } })}
    skillNames={names}
  />)

  expect(container.innerHTML).toBe("")
})
