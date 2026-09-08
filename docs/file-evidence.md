# Per-file evidence

Request `session.evidence` with `{ sessionId, includeFileAssociations: true }` to
receive `fileAssociations`. Runs remain in `tests.runs`; associations reference
their IDs, so a run can belong to several files without duplicating its command
or output. Each visible `workspace.files` path has exactly one association.
The list follows the existing 200-file bound, including when more files changed.

```ts
type FileEvidenceAssociation = {
  path: string
  tests:
    | { state: "unknown"; reason: "file-access-not-recorded" }
    | { state: "known"; runIds: string[] }
  revertTarget:
    | { kind: "restore"; baseCommit: string; checkpointId?: string }
    | { kind: "remove"; baseCommit: string; checkpointId?: string }
    | { kind: "unavailable"; reason: "target-not-observed" | "unsupported-path" }
}
```

The exported schemas and inferred types in `packages/protocol/src/rpc.ts` are
the runtime contract. `baseCommit` is a full, lowercase, 40-character Git SHA.
An available target must match `workspace.baseCommit` and name a path accepted
by `session.revertFile`.

## Run evidence and unknown coverage

The daemon currently emits `tests.state: "unknown"` for every file. Canonical
tool records retain command text, completion status and output. They retain no
file-access or coverage telemetry. A path in a command, a path in failure output,
two adjacent tool events, or the absence of recorded runs cannot establish a
file association. The UI must say that Domovoi cannot tell which runs touched
the file. It cannot currently claim "no test touched it" or "2 runs · 1 failing"
for that file.

`known` reserves a validated representation for a future producer with complete
file-access observations for the retained command runs. It requires unique IDs
that exist in `tests.runs`, and is rejected when `tests.runsTruncated` is true.
Only `known` with an empty `runIds` proves that none of those retained observed
runs touched the file. It does not prove that no test ever touched it, that every
test execution was recorded, or that the file's current contents were tested.
No such producer is added here.

For a known association, count referenced runs and inspect their `status` for
the chip. `passed` and `failed` describe the recorded command's completion, not
an individual assertion count or line coverage. The existing global test
summary keeps its meaning.

## The actual revert target

File revert uses the worktree's captured `HEAD`. On opt-in the daemon reads that commit's
Git tree to distinguish restoring a path that exists there from removing a path
that does not. The tree read shares the evidence deadline and has a 32 MiB output
limit. Read failures cannot become a claim that the path is absent.

When a retained checkpoint record for the same session names exactly that
commit, `checkpointId` names that record. Otherwise the confirmation must name
the commit. There is no separate per-file checkpoint history today. A checkpoint
that changed some other file can still be the current whole-worktree baseline.
The recovery checkpoint created during revert preserves the discarded state;
it is not the restore target and must not appear as that target in confirmation.

`restore` restores the named path from `baseCommit`. `remove` removes it because
the path was absent there. A rename destination can therefore have a removal
target; reverting that destination does not also restore `previousPath`.
`unavailable` means the service did not observe the target, or the path cannot
be submitted to file revert. Keep revert unavailable in that state.

After confirmation, send `{ sessionId, path, client, expectedBaseCommit }` to
`session.revertFile`, copying `expectedBaseCommit` from the target's `baseCommit`.
If `HEAD` changed, the daemon refuses before the recovery checkpoint or any file
mutation, with code `-32602` and this message:

> Revert target changed; refresh file evidence before confirming again

Refresh evidence and obtain a new confirmation. The commit guard binds the
restore target, not the current uncommitted file contents. It does not lock out
external Git operations or filesystem edits. The existing active-turn guard and
recovery checkpoint remain in effect.

## Compatibility

Without `includeFileAssociations`, the daemon returns the existing response
shape. The optional extension therefore does not change the wire version.
An older daemon can ignore the opt-in and return no `fileAssociations`; clients
must treat absence as unknown test links and an unavailable revert target.
An empty association list is valid only when the visible changed-file list is
empty. Missing associations for visible files are rejected.

Legacy revert requests without `expectedBaseCommit` retain their behavior.
Clients using the new confirmation should always supply it. Older daemons
reject this new revert parameter rather than silently ignoring the guard.
