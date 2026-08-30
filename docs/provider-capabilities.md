# Provider capability policy

Domovoi prefers a provider's subscription CLI when that CLI already supplies the full coding-agent loop: authentication, model selection, tools, permissions, session resume, and usage reporting. Direct API adapters are added only when they provide a user-visible capability that the corresponding CLI cannot provide.

## Local desktop alpha

| Provider | Integration | Direct API adapter | Reason |
| --- | --- | --- | --- |
| Claude | Claude Agent SDK / Claude Code credentials | No | The SDK supplies the coding loop and subscription authentication. |
| Codex | Codex app server / Codex credentials | No | The app server supplies sessions, tools, approvals, and model selection. |
| Cursor | ACP over `agent acp` | No | ACP supplies the coding loop and Cursor subscription authentication. |
| Grok | ACP over `grok agent stdio` | No | ACP supplies the coding loop and Grok subscription authentication. |
| OpenCode | OpenCode SDK | No | The SDK already owns the coding loop. |
| Kilo | Kilo SDK | No | The SDK already owns the coding loop. |

OpenAI, Anthropic, and OpenRouter keys may be stored in the execution machine's OS keychain. Key storage does not imply that a direct adapter exists. Domovoi never falls back to plaintext files, returns key material through RPC, or sends keys through a client or relay.

## Re-evaluation gate

A direct adapter proposal must name the missing CLI capability, define its permission and session semantics, include normalized usage and provider-failure handling, and explain why extending the existing CLI adapter cannot close the gap. Raw chat completion access by itself does not pass this gate because it would duplicate the agent loop without preserving tool and approval guarantees.
