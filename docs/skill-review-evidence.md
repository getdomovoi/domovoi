# Skill review evidence

The capability manifest accepts two versions. Version 1 remains exactly
`{ version: 1, capabilities: SkillCapability[] }`; its declared scopes are unknown.
Version 2 keeps that capability ID array and adds `scopes`, with exactly one typed
scope declaration for every capability. It never fills unknown scopes with `all`.
`SkillSummary` and `SkillEnablementReview` retain their existing outer shape.

```ts
{
  version: 2,
  capabilities: ["network.connect", "process.execute"],
  scopes: [
    { capability: "network.connect", scope: { kind: "hosts", hosts: ["api.example.test"] } },
    { capability: "process.execute", scope: {
      kind: "commands", commands: [{ executable: "pnpm", args: ["test"] }]
    } }
  ]
}
```

These are declarations for review. They do not enforce provider permissions,
network isolation, subprocess access, executable resolution or symlink boundaries.
The daemon still checks the exact reviewed content digest and manifest before
injecting a skill into a prompt. Changing declarations does not carry old consent
to the new content.

| Capability | Narrow scope | Meaning |
| --- | --- | --- |
| `filesystem.read`, `filesystem.write` | `{ kind: "paths", paths: [{ root, path, recursive }] }` | `root` is `workspace` or `absolute`. Paths use canonical forward slashes. `.` is the workspace root; absolute paths use `/` or an uppercase Windows drive. `recursive` explicitly includes descendants. |
| `network.connect` | `{ kind: "hosts", hosts: string[] }` | Exact canonical hostnames or IP literals, all ports and transports. No wildcard, URL, subdomain inference or DNS-address equivalence. IPv6 literals use brackets. |
| `process.execute` | `{ kind: "commands", commands: [{ executable, args }] }` | Exact executable spelling and exact argument order. No shell-pattern or prefix matching; this does not constrain the command's effects. |
| `secrets.read` | `{ kind: "names", names: string[] }` | Exact declared secret names. |
| `preview.render` | None | Only the explicit `all` scope is supported. |

Every capability also supports `{ kind: "all" }`. Lists are nonempty sets, except
command arguments, which may be empty and retain order. Path comparisons are
lexical and case-sensitive, including Windows paths. UNC paths and path aliases
are outside this version's grammar. The whole manifest is bounded to 64 Ki UTF-16
code units, separately from the source document's byte bound.

## Comparing reviews

`compareSkillDeclaredScopes(baselineManifest, currentManifest)` returns:

```ts
{ state: "unknown", reason: "baseline" | "current" }
// or
{ state: "known", changes: [{
  capability, change: "widened" | "narrowed" | "changed",
  gained: boolean, lost: boolean, before, after
}] }
```

A missing review or v1 baseline returns `unknown/baseline`. The client must show a
first review, approved as new. Neither "no capability change" nor "capabilities
changed" is supported by that baseline. A v1 current declaration returns
`unknown/current` even if an older v2 baseline exists; the client must disclose the
missing current scope instead of claiming the earlier declaration was absent.

Known comparisons cover capabilities present in both manifests. Added and removed
capability IDs remain the separate first tier. The helper ignores set ordering,
compares complete path components and preserves argument order. A non-nested
replacement reports `changed`, with both `gained` and `lost` true. A loss never
offsets a gain: any `gained: true` belongs in the scope expansion warning tier.
An unchanged scope produces no change entry. `skillCapabilityManifestsEqual`
compares versions, capability sets and these scope meanings for consent checks.

## Retrieving reviewed text

`skill.reviewRevision({ id, contentDigest })` is a read-only RPC. Its result is:

```ts
{ id, contentDigest, state: "available", content: string, bytes: number }
// or
{ id, contentDigest, state: "unavailable", reason: "not-retained" | "integrity-mismatch" }
```

`content` is the exact reviewed `SKILL.md` text covered by that digest, including
frontmatter, line endings and whitespace. `bytes` counts its UTF-8 encoding.
The daemon verifies the digest again before serving it. Retrieval requires a
matching review for the active project or a matching machine manual review;
knowing another document's digest alone grants no access.

The production SQLite store deduplicates revisions by digest. A document is at most
128 KiB; retained text totals at most 64 MiB, with at most 4,096 revisions. Retaining
a reviewed revision updates its retention order; the oldest retained reviews are
evicted when either bound is exceeded. These are retained payload limits, not a
promise about the total SQLite file or journal size. Reads do not refresh retention.
Revision bytes stay out of workspace snapshots, fleet inventory and session transfer.

Legacy approvals have no retained text. Eviction, missing storage support and an
unmatched review return `not-retained`; damaged retained text returns
`integrity-mismatch`. Neither result means unchanged or zero changed lines. Clients
may calculate an instruction diff only when both exact revisions are available.
Retention supplies review evidence; it grants no skill trust or project enablement.
