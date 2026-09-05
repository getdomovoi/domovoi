import type { ProviderPromptDelivery } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { PromptDeliveryNote } from "./prompt-delivery-note.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}` as const

function delivery(overrides: Partial<ProviderPromptDelivery["skills"]> = {}): ProviderPromptDelivery {
  return {
    version: 1,
    budget: { unit: "utf16-code-units", limit: 262_144, used: 1_024 },
    handoff: { status: "not-required" },
    workingPlan: { status: "not-required" },
    annotations: { availableIds: [], deliveredIds: [], omitted: { budget: 0, limit: 0 } },
    skills: {
      delivered: [],
      omitted: { budget: [], limit: [], unavailable: [], reviewChanged: [], policy: [] },
      ...overrides,
    },
  } as unknown as ProviderPromptDelivery
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
      omitted: {
        budget: ["skill-aaaaaaaaaaaa"],
        limit: [],
        unavailable: [],
        reviewChanged: ["skill-bbbbbbbbbbbb"],
        policy: [],
      },
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
    delivery={delivery({ omitted: { budget: ["skill-cccccccccccc"], limit: [], unavailable: [], reviewChanged: [], policy: [] } })}
    skillNames={names}
  />)

  expect(screen.getByRole("note", { name: "Prompt delivery" }).textContent).toContain("skill-cccccccccccc")
})
