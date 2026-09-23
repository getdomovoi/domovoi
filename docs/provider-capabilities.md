# Provider capability policy

Domovoi prefers a provider's subscription CLI when that CLI already supplies the full coding-agent loop: authentication, model selection, tools, permissions, session resume, and usage reporting. Direct API adapters are added only when they provide a user-visible capability that the corresponding CLI cannot provide.

## Local desktop alpha

| Provider | Integration | Direct API adapter | Reason |
| --- | --- | --- | --- |
| Claude | Claude Agent SDK driving the installed `claude` / Claude Code credentials | No | The SDK supplies the coding loop and subscription authentication. The daemon passes it the `claude` found on the tool PATH. |
| Codex | Codex app server / Codex credentials | No | The app server supplies sessions, tools, approvals, and model selection. |
| Cursor | ACP over `agent acp` | No | ACP supplies the coding loop and Cursor subscription authentication. |
| Grok | ACP over `grok agent stdio` | No | ACP supplies the coding loop and Grok subscription authentication. |
| OpenCode | OpenCode SDK | No | The SDK already owns the coding loop. |
| Kilo | Kilo SDK | No | The SDK already owns the coding loop. |

OpenAI, Anthropic, and OpenRouter keys may be stored in the execution machine's OS keychain. Key storage does not imply that a direct adapter exists. Domovoi never falls back to plaintext files, returns key material through RPC, or sends keys through a client or relay.

## Re-evaluation gate

A direct adapter proposal must name the missing CLI capability, define its permission and session semantics, include normalized usage and provider-failure handling, and explain why extending the existing CLI adapter cannot close the gap. Raw chat completion access by itself does not pass this gate because it would duplicate the agent loop without preserving tool and approval guarantees.

## Vendor terms to watch

Recorded 2026-09-22. The Claude row depends on terms Domovoi does not control.

- The vendor's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance), read
  2026-09-22, says: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage
  of Claude Code and the Agent SDK." The Claude adapter drives sessions through the Agent SDK.
- Trade press
  ([report dated 2026-06-18](https://devops.com/anthropic-hits-pause-on-claude-agent-sdk-billing-change-for-now/))
  reported that the vendor planned to move Agent SDK, headless and third-party app usage off
  subscription limits onto a separate monthly credit, then paused that change on 2026-06-15 and
  told subscribers nothing changes for now. That is a report, not a vendor notice this repository
  holds. It describes a pause, not a withdrawal.

If a change like that takes effect, say in the provider row and in the session UI which pool a
Claude session draws from, and stop describing it as subscription-backed. Moving the adapter to the
installed CLI over ACP would not avoid it on its own, because the reported plan also covered
third-party app usage.
