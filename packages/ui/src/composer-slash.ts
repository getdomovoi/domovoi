import type { PermissionMode } from "@getdomovoi/protocol"

export type SlashCommand = {
  name: string
  argument: string
  note: string
}

export const slashCommands: readonly SlashCommand[] = [
  {
    name: "/run",
    argument: "pnpm prisma migrate deploy",
    note: "Runs it now, in the worktree. Still gated if no rule covers it, and the gate says the request came from you.",
  },
  {
    name: "/revert",
    argument: "ckpt_7f24",
    note: "Rewinds the worktree and the thread together to that checkpoint. Nothing merged is touched.",
  },
  {
    name: "/replan",
    argument: "from step 3",
    note: "Keeps the finished steps and asks for a new plan for the rest. The old plan stays readable in the thread.",
  },
  {
    name: "/mode",
    argument: "plan · ask · build",
    note: "Applies from the next turn. A turn already in flight keeps the mode it started with, and auto is only legal with build.",
  },
  {
    name: "/skill",
    argument: "pr-triage",
    note: "Loads a skill for this turn only. Unsigned skills stay blocked in auto modes.",
  },
  {
    name: "/handoff",
    argument: "hetzner-cx42",
    note: "Opens the pre-flight checks first. Nothing moves until they pass and you confirm.",
  },
]

export type SlashIntent =
  | { kind: "send", prompt: string }
  | { kind: "mode", permissionMode: PermissionMode }
  | { kind: "revert", checkpointId: string }
  | { kind: "skill", skillId: string }
  | { kind: "handoff", machineId: string }
  | { kind: "invalid", message: string }

export type SlashIntentContext = {
  checkpointIds: readonly string[]
  skills: readonly { id: string, name: string }[]
  machines: readonly { id: string, label: string, self: boolean }[]
}

const slashUsage = {
  run: "Usage: /run <command>",
  revert: "Usage: /revert <checkpoint-id>. Choose a checkpoint from this active session.",
  replan: "Usage: /replan [from step N]",
  mode: "Usage: /mode <plan|ask|build>",
  skill: "Usage: /skill <reviewed-skill>",
  handoff: "Usage: /handoff <target-machine>",
} as const

function oneMatch<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  const matched = items.filter(matches)
  return matched.length === 1 ? matched[0] : undefined
}

export function slashIntent(input: string, context: SlashIntentContext): SlashIntent {
  const trimmed = input.trim()
  const separator = trimmed.search(/\s/u)
  const command = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase()
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim()
  switch (command) {
    case "/run":
      return argument
        ? { kind: "send", prompt: `Run this command in the worktree:\n\n${argument}` }
        : { kind: "invalid", message: slashUsage.run }
    case "/replan":
      return {
        kind: "send",
        prompt: argument
          ? `Replan the remaining work ${argument}${/[.!?]$/u.test(argument) ? "" : "."}`
          : "Replan the remaining work while preserving completed steps and prior plan history.",
      }
    case "/mode":
      return argument === "plan" || argument === "ask" || argument === "build"
        ? { kind: "mode", permissionMode: argument }
        : { kind: "invalid", message: slashUsage.mode }
    case "/revert": {
      const checkpoint = oneMatch(context.checkpointIds, (id) => id === argument)
      return checkpoint
        ? { kind: "revert", checkpointId: checkpoint }
        : { kind: "invalid", message: slashUsage.revert }
    }
    case "/skill": {
      const normalized = argument.toLowerCase()
      const skill = oneMatch(context.skills, (candidate) =>
        candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
      )
      return skill
        ? { kind: "skill", skillId: skill.id }
        : { kind: "invalid", message: slashUsage.skill }
    }
    case "/handoff": {
      const normalized = argument.toLowerCase()
      const machine = oneMatch(context.machines, (candidate) =>
        !candidate.self && (candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized)
      )
      return machine
        ? { kind: "handoff", machineId: machine.id }
        : { kind: "invalid", message: slashUsage.handoff }
    }
    default:
      return { kind: "invalid", message: "Usage: /run, /revert, /replan, /mode, /skill, or /handoff" }
  }
}
