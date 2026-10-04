import type { PermissionMode } from "@getdomovoi/protocol"

export type SlashCommand = {
  name: string
  // The argument's shape, shown when this session has nothing of that kind.
  // The design's own arguments name its fictional session, so none is used.
  placeholder: string
  note: string
  // A real argument from this session, when it has one to offer.
  live?: (context: SlashIntentContext) => string | undefined
}

export const slashCommands: readonly SlashCommand[] = [
  {
    name: "/run",
    placeholder: "<command>",
    // The composer sends the agent a request; the agent runs the command, so
    // it is gated like any other. No gate field says the request came from
    // the composer, so the note does not claim the gate says so.
    note: "Asks the agent to run it in the worktree. Gates and rules apply as to any command the agent runs.",
  },
  {
    name: "/revert",
    placeholder: "<checkpoint-id>",
    // Ruled Q341 A: revert is worktree-only. checkpoint.restore resets the
    // files, records a checkpoint of the state before it and a system row,
    // and leaves every turn in the thread.
    note: "Resets the worktree to that checkpoint and keeps a checkpoint of the state before it. The thread keeps every turn.",
    live: (context) => context.checkpointIds.at(-1),
  },
  {
    name: "/replan",
    placeholder: "[from step N]",
    note: "Keeps the finished steps and asks for a new plan for the rest. The old plan stays readable in the thread.",
  },
  {
    name: "/mode",
    placeholder: "plan · ask · build",
    note: "Applies from the next turn. A turn already in flight keeps the mode it started with, and auto is only legal with build.",
  },
  {
    name: "/skill",
    placeholder: "<reviewed-skill>",
    // In Build with Auto the daemon requires a trusted skill and refuses the
    // turn otherwise (apps/daemon/src/skill-context.ts, requireTrusted).
    note: "Loads a skill for this turn only. With Auto on, the daemon refuses a skill that is not trusted.",
    live: (context) => context.skills[0]?.name,
  },
  {
    name: "/handoff",
    placeholder: "<target-machine>",
    note: "Opens the pre-flight checks first. Nothing moves until they pass and you confirm.",
    live: (context) => context.machines.find((machine) => !machine.self)?.label,
  },
]

// The latest checkpoint, the first reviewed skill and the first other machine
// come from this session; every other argument shows its shape.
export function slashArgument(command: SlashCommand, context: SlashIntentContext): string {
  return command.live?.(context) ?? command.placeholder
}

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
