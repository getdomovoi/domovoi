import { useMemo, useState } from "react"
import { Modal, Pressable, TextInput, View } from "react-native"
import type {
  ApprovalDecision,
  ApprovalRequest,
  ClientAccess,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { artifactBody, artifactRows, diffLines } from "./artifact-rows"
import type { ConnectionNotice } from "./connection-notice"
import { ConnectionBanner } from "./components/connection-banner"
import { cn } from "./lib/cn"
import { planForSession, planSummary } from "./plan-rows"
import { sessionDetail, type SessionDetail, type ThreadEntry } from "./session-detail"
import { sessionGroups, type SessionRow } from "./session-rows"
import { useTheme } from "./theme/theme-provider"
import { Button } from "./components/ui/button"
import { Card } from "./components/ui/card"
import { Icon } from "./components/ui/icon"
import { Text } from "./components/ui/text"
import { PageScroller } from "./components/page-scroller"
import { approvalFacts } from "./screens/approval"
import { PolicyRefusalCards } from "./screens/session"

type TabletDecision = Extract<ApprovalDecision, "allow-once" | "always-project">
type ReviewTab = "changes" | "diff" | "plan" | "review"

function TabletSessionRow({ row, selected, access, onPress }: {
  row: SessionRow
  selected: boolean
  access: ClientAccess
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={row.title}
      onPress={onPress}
      className={cn(
        "flex-row items-start gap-2.5 rounded-xl px-3 py-2.5 active:opacity-70",
        selected && "bg-accent",
      )}
    >
      <View className={cn(
        "mt-[6px] h-[7px] w-[7px] rounded-full",
        row.dot === "active" ? "bg-success" : row.dot === "waiting" ? "bg-warning" : "bg-faint",
      )} />
      <View className="min-w-0 flex-1">
        <Text className="text-[13px] leading-[18px] text-strong" numberOfLines={2}>{row.title}</Text>
        <Text variant="machine" className="mt-1 text-faint">
          {row.attention === "approval"
            ? access === "full" ? "waiting on you" : "waiting on a full-access device"
            : row.dot === "active" ? "running" : "quiet"}
        </Text>
      </View>
    </Pressable>
  )
}

export function TabletSessionsPane({ snapshot, selectedSessionId, access, onSelectSession, onNewSession, onOpenMachines }: {
  snapshot: WorkspaceSnapshot
  selectedSessionId: string | undefined
  access: ClientAccess
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onOpenMachines: () => void
}) {
  const groups = sessionGroups(snapshot)
  return (
    <View testID="tablet-sessions-pane" className="w-[30%] min-w-[260px] max-w-[340px] border-r border-border bg-sidebar">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-3">
        <Text variant="nav" className="flex-1">Domovoi</Text>
        <Button title="Machines" onPress={onOpenMachines} />
      </View>
      <View className="px-3 py-3">
        <Button title="New session" variant="primary" shape="block" onPress={onNewSession} />
      </View>
      <PageScroller contentContainerClassName="gap-4 px-2 pb-6">
        {groups.map((group) => (
          <View key={group.id} className="gap-1.5">
            <View className="flex-row items-center px-2">
              <Text variant="label" className="flex-1">{group.label}</Text>
              <Text variant="machine" className="text-faint">{group.rows.length}</Text>
            </View>
            {group.rows.map((row) => (
              <TabletSessionRow
                key={row.id}
                row={row}
                selected={row.id === selectedSessionId}
                access={access}
                onPress={() => onSelectSession(row.id)}
              />
            ))}
          </View>
        ))}
      </PageScroller>
    </View>
  )
}

export function TabletThreadHeader({ snapshot, detail, artifactCount, onOpenReview }: {
  snapshot: WorkspaceSnapshot
  detail: SessionDetail
  artifactCount: number
  onOpenReview: () => void
}) {
  const { resolved, setPreference } = useTheme()
  const session = snapshot.sessions.find((candidate) => candidate.id === detail.id)
  const worktree = session?.workspacePath?.split(/[\\/]/u).at(-1)
  const project = snapshot.project
  return (
    <View className="min-h-[60px] flex-row items-center gap-3 border-b border-border px-5 py-3">
      <View className="min-w-0 flex-1">
        <Text variant="nav" numberOfLines={1}>{detail.title}</Text>
        <Text variant="machine" className="mt-1 text-faint" numberOfLines={1}>
          {[project?.name, project?.branch, worktree].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Button title={`${artifactCount} files`} accessibilityLabel={`Open review sheet, ${artifactCount} files`} onPress={onOpenReview} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Use ${resolved === "dark" ? "light" : "dark"} appearance`}
        onPress={() => setPreference(resolved === "dark" ? "light" : "dark")}
        className="min-h-tap min-w-tap items-center justify-center rounded-xl bg-accent active:opacity-70"
      >
        <Icon name="settings" tone="muted" size={18} />
      </Pressable>
    </View>
  )
}

export function TabletGateCard({ approval, onResolve, onDenyExplain, watching = false }: {
  approval: ApprovalRequest
  // The revision is the one this card shows, so the daemon can refuse an
  // Allow given to a card it has since rewritten.
  onResolve: (approvalId: string, decision: TabletDecision, revision: number) => void
  onDenyExplain: (approvalId: string) => void
  watching?: boolean
}) {
  const hardGate = approval.risk === "hard-gate"
  return (
    <Card flush className="overflow-hidden border-warn-border bg-warn-bg">
      <View className="flex-row items-center gap-2.5 px-4 py-3.5">
        <View className="h-[9px] w-[9px] rounded-full bg-warning" />
        <Text className="flex-1 font-sans-medium text-[15px] text-warn-fg">
          {hardGate ? "Approval required, hard gate" : "Approval required"}
        </Text>
        <Text variant="machine" className="text-warn-dim">{approval.agent}</Text>
      </View>
      <View className="gap-2.5 px-4 pb-3.5">
        <Text className="text-[13px] leading-[19px] text-warn-fg">{approval.operation}</Text>
        <View className="rounded-xl bg-warn-deep px-3.5 py-3">
          <Text variant="machine" className="text-warn-fg">{approval.command}</Text>
        </View>
      </View>
      <View className="flex-row flex-wrap border-t border-warn-border">
        {approvalFacts(approval).map((fact) => (
          <View key={fact.key} className="w-1/2 border-b border-warn-border px-4 py-3">
            <Text variant="label" className="text-warn-dim">{fact.key}</Text>
            <Text variant="machine" className="mt-1 text-warn-fg">{fact.value}</Text>
          </View>
        ))}
      </View>
      {watching ? (
        <Text variant="note" className="px-4 py-3.5 text-warn-dim">
          Watching only. A device paired with full access answers this gate.
        </Text>
      ) : (
      <View className="gap-2 px-4 py-3.5">
        <Button
          title="Allow once"
          variant="affirm"
          className="h-[52px] rounded-xl"
          onPress={() => onResolve(approval.id, "allow-once", approval.revision)}
        />
        <View className="flex-row gap-2">
          {/* The daemon refuses a standing rule on a hard gate and for a request
              it could not resolve (ruled 2026-09-24). */}
          {hardGate || approval.execution.state !== "resolved" ? null : (
            <Button title="Always here" className="h-12 flex-1 rounded-xl border-warn-border" onPress={() => onResolve(approval.id, "always-project", approval.revision)} />
          )}
          <Button title="Deny" className="h-12 flex-1 rounded-xl border-warn-border" onPress={() => onDenyExplain(approval.id)} />
        </View>
      </View>
      )}
    </Card>
  )
}

export function TabletReceipt({ entry }: { entry: Extract<ThreadEntry, { kind: "receipt" }> }) {
  return (
    <Card className="gap-1.5 border-ok-border bg-ok-bg">
      <View className="flex-row items-center gap-2">
        <View className="h-2 w-2 rounded-full bg-success" />
        <Text className="flex-1 font-sans-medium text-[14px] text-ok-fg">{entry.decision}</Text>
        <Text variant="machine" className="text-ok-dim">{entry.duration ?? entry.attribution}</Text>
      </View>
      <Text className="text-[13px] leading-[19px] text-ok-fg">
        {entry.operation}. Checkpoint {entry.checkpoint} was recorded before it ran.
      </Text>
    </Card>
  )
}

function TabletThreadEntry({ entry }: { entry: ThreadEntry }) {
  if (entry.kind === "receipt") return <TabletReceipt entry={entry} />
  if (entry.kind === "message") {
    return entry.voice === "you" ? (
      <View className="items-end">
        <View className="max-w-[78%] rounded-2xl rounded-br-md bg-accent px-4 py-3">
          <Text className="text-[14px] leading-[21px]">{entry.body}</Text>
        </View>
      </View>
    ) : <Text className="text-[14px] leading-[22px]">{entry.body}</Text>
  }
  if (entry.kind === "policy-refusal") {
    return (
      <View className="gap-3">
        <Text variant="nav">{entry.operation}</Text>
        <PolicyRefusalCards refusal={entry} />
      </View>
    )
  }
  return <Text variant="note">{entry.body}{entry.meta ? ` · ${entry.meta}` : ""}</Text>
}

export function TabletThread({ snapshot, detail, approval, access, onResolve, onDenyExplain }: {
  snapshot: WorkspaceSnapshot
  detail: SessionDetail
  approval: ApprovalRequest | undefined
  access: ClientAccess
  onResolve: (approvalId: string, decision: TabletDecision, revision: number) => void
  onDenyExplain: (approvalId: string) => void
}) {
  const tools = snapshot.thread.filter((item) => item.sessionId === detail.id && item.kind === "tool").length
  const files = snapshot.artifacts.filter((artifact) => artifact.sessionId === detail.id).length
  return (
    <PageScroller
      testID="tablet-thread"
      className="flex-1"
      contentContainerClassName="grow justify-end gap-5 px-6 pb-3 pt-6"
    >
      {detail.entries.map((entry) => <TabletThreadEntry key={entry.id} entry={entry} />)}
      {tools > 0 || files > 0 ? (
        <View className="flex-row items-center gap-2 self-start rounded-full border border-border px-3 py-2">
          <Icon name="chevron-right" tone="faint" size={14} />
          <Text className="text-[12.5px]">Work this turn</Text>
          <Text variant="machine" className="text-faint">{tools} tools · {files} files</Text>
        </View>
      ) : null}
      {approval
        ? <TabletGateCard approval={approval} onResolve={onResolve} onDenyExplain={onDenyExplain} watching={access !== "full"} />
        : null}
    </PageScroller>
  )
}

export function TabletComposer({ detail, draft, sending, onChangeDraft, onSend }: {
  detail: SessionDetail
  draft: string
  sending: boolean
  onChangeDraft: (draft: string) => void
  onSend: () => void
}) {
  const canSend = detail.sending.can && !sending && draft.trim().length > 0
  return (
    <View className="flex-row items-end gap-2 px-6 pb-4 pt-3">
      <View className="min-h-[52px] flex-1 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4">
        <TextInput
          multiline
          accessibilityLabel="Tablet reply"
          editable={detail.sending.can && !sending}
          value={draft}
          onChangeText={onChangeDraft}
          placeholder="Reply, or steer the plan"
          className="max-h-32 flex-1 py-3 font-sans text-[14px] text-foreground"
        />
        <Text variant="machine" className="text-faint">{detail.runtime}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        accessibilityState={{ disabled: !canSend, busy: sending }}
        disabled={!canSend}
        onPress={onSend}
        className={cn("h-[52px] w-[52px] items-center justify-center rounded-2xl", canSend ? "bg-primary" : "bg-accent")}
      >
        <Icon name="arrow-up" tone={canSend ? "primary-foreground" : "faint"} size={18} />
      </Pressable>
    </View>
  )
}

export function TabletReviewSheet({ open, snapshot, sessionId, access, onPostReview, onClose }: {
  open: boolean
  snapshot: WorkspaceSnapshot
  sessionId: string
  access: ClientAccess
  onPostReview: (artifactId: string, body: string) => Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = useState<ReviewTab>("changes")
  const [draft, setDraft] = useState("")
  const [posting, setPosting] = useState(false)
  const [postProblem, setPostProblem] = useState("")
  // The draft is cleared only once the daemon has the comment, so a refusal
  // leaves what was written in place beside the reason.
  const post = async (artifactId: string) => {
    setPosting(true)
    setPostProblem("")
    try {
      await onPostReview(artifactId, draft.trim())
      setDraft("")
    } catch (cause) {
      setPostProblem(`Not posted: ${cause instanceof Error ? cause.message : "the daemon did not take the comment"}`)
    } finally {
      setPosting(false)
    }
  }
  const artifacts = artifactRows(snapshot, sessionId)
  const diff = snapshot.artifacts.find((artifact) => artifact.sessionId === sessionId && artifact.type === "diff")
  const preview = snapshot.artifacts.find((artifact) => artifact.sessionId === sessionId && artifact.type === "preview")
  const plan = planForSession(snapshot, sessionId)
  const diffBody = diff ? artifactBody(diff) : undefined
  const rows = plan ? planSummary(plan).rows : []
  const tabs: Array<{ id: ReviewTab, label: string }> = [
    { id: "changes", label: "Changes" },
    { id: "diff", label: "Diff" },
    { id: "plan", label: "Plan" },
    { id: "review", label: "Review" },
  ]
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close review sheet" className="flex-1 bg-desk/80" onPress={onClose} />
      <View className="h-[74%] rounded-t-[22px] border-t border-border bg-background">
        <View className="items-center py-2"><View className="h-[5px] w-11 rounded-full bg-muted" /></View>
        <View className="flex-row items-center gap-1 border-b border-border px-4 pb-2">
          {tabs.map((item) => (
            <Button key={item.id} title={item.label} variant={tab === item.id ? "primary" : "ghost"} onPress={() => setTab(item.id)} />
          ))}
          <View className="flex-1" />
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} className="min-h-tap min-w-tap items-center justify-center rounded-xl bg-accent"><Icon name="x" tone="muted" /></Pressable>
        </View>
        <PageScroller contentContainerClassName="gap-3 px-5 py-4">
          {tab === "changes" ? artifacts.map((artifact) => (
            <Card key={artifact.id} className="min-h-[56px] flex-row items-center gap-3">
              <Text variant="machine" className="text-primary">{artifact.type.toUpperCase()}</Text>
              <Text variant="machine" className="flex-1 text-strong" numberOfLines={1}>{artifact.title}</Text>
              <Text variant="machine" className="text-faint">r{artifact.revision}</Text>
            </Card>
          )) : null}
          {tab === "diff" ? (
            diffBody?.readable ? <Card flush className="overflow-hidden"><View className="bg-code px-3 py-2.5">{diffLines(diffBody.lines).map((line, index) => <Text key={`${index}-${line.text}`} variant="machine" className={line.tone === "added" ? "text-success" : line.tone === "removed" ? "text-destructive" : "text-muted-foreground"}>{line.text || " "}</Text>)}</View></Card>
              : <Text variant="note">No readable diff is available for this session.</Text>
          ) : null}
          {tab === "plan" ? rows.map((row) => <Card key={row.id} className="flex-row gap-3"><Text variant="machine" className="text-primary">{row.mark}</Text><View className="flex-1"><Text>{row.text}</Text><Text variant="machine" className="mt-1 text-faint">{row.meta}</Text></View></Card>) : null}
          {tab === "review" ? (
            preview ? <>
              <Card className="gap-2"><Text variant="title">{preview.title}</Text><Text variant="note">Tap a bubble to comment. Comments reference that element in this render.</Text></Card>
              {access !== "full" ? (
                <Text variant="note">Watching only. A device paired with full access can post a review.</Text>
              ) : (
              <Card className="gap-2 border-primary">
                <TextInput
                  multiline
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Say what is wrong with this element"
                  accessibilityLabel="Review comment"
                  className="min-h-[66px] font-sans text-[14px] text-foreground"
                />
                {postProblem ? <Text variant="note" className="text-destructive">{postProblem}</Text> : null}
                <View className="flex-row gap-2">
                  <Button title="Post" variant="primary" disabled={!draft.trim() || posting} onPress={() => void post(preview.id)} />
                  <Button title="Cancel" onPress={() => { setDraft(""); setPostProblem("") }} />
                </View>
              </Card>
              )}
            </> : <Text variant="note">No design render is available for review.</Text>
          ) : null}
        </PageScroller>
      </View>
    </Modal>
  )
}

export function TabletShell({
  snapshot,
  notice,
  selectedSessionId,
  draft,
  access,
  sending,
  onSelectSession,
  onNewSession,
  onOpenMachines,
  onChangeDraft,
  onSend,
  onResolve,
  onDenyExplain,
  onPostReview,
}: {
  snapshot: WorkspaceSnapshot
  // What the connection says when it is not simply working, including a frame
  // this app could not read. The tablet shows it as the phone screens do.
  notice?: ConnectionNotice | undefined
  selectedSessionId: string | undefined
  draft: string
  access: ClientAccess
  sending: boolean
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onOpenMachines: () => void
  onChangeDraft: (draft: string) => void
  onSend: (sessionId: string) => void
  onResolve: (approvalId: string, decision: TabletDecision, revision: number) => void
  onDenyExplain: (approvalId: string) => void
  onPostReview: (artifactId: string, body: string) => Promise<void>
}) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const fallbackSessionId = snapshot.activeSessionId ?? snapshot.sessions[0]?.id
  const sessionId = selectedSessionId && snapshot.sessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : fallbackSessionId
  const detail = useMemo(
    () => sessionId ? sessionDetail(snapshot, sessionId, access) : undefined,
    [access, sessionId, snapshot],
  )
  if (!sessionId || !detail) return <View className="flex-1 items-center justify-center"><Text variant="meta">No session is selected.</Text></View>
  const approval = snapshot.approvals.find((candidate) => candidate.sessionId === sessionId)
  const artifactCount = snapshot.artifacts.filter((artifact) => artifact.sessionId === sessionId).length
  return (
    <View className="flex-1 flex-row bg-background">
      <TabletSessionsPane
        snapshot={snapshot}
        selectedSessionId={sessionId}
        access={access}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onOpenMachines={onOpenMachines}
      />
      <View className="min-w-0 flex-1">
        <TabletThreadHeader snapshot={snapshot} detail={detail} artifactCount={artifactCount} onOpenReview={() => setReviewOpen(true)} />
        {notice ? <View className="px-6 pt-3"><ConnectionBanner notice={notice} /></View> : null}
        <TabletThread
          snapshot={snapshot}
          detail={detail}
          approval={approval}
          access={access}
          onResolve={onResolve}
          onDenyExplain={onDenyExplain}
        />
        <TabletComposer detail={detail} draft={draft} sending={sending} onChangeDraft={onChangeDraft} onSend={() => onSend(sessionId)} />
      </View>
      <TabletReviewSheet open={reviewOpen} snapshot={snapshot} sessionId={sessionId} access={access} onPostReview={onPostReview} onClose={() => setReviewOpen(false)} />
    </View>
  )
}
