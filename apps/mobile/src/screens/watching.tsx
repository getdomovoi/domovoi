import { useEffect, useMemo, useRef, useState } from "react"
import { Pressable, View } from "react-native"

import { ConnectionBanner } from "../components/connection-banner"
import { PageScroller, type PageScrollerHandle } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import {
  claimantLine,
  followAfterOutput,
  followAfterScroll,
  followJump,
  followStart,
  followToggle,
  showJump,
  terminalLineCount,
  terminalRows,
  terminalSize,
  terminalStatus,
  terminalTitle,
  watchedSummary,
  type TerminalRecord,
  type TerminalRow,
  type TerminalTone,
  type TerminalWatch,
} from "../terminal-rows"

// Phone v2 frame 04. A phone reads the claimant's shell. It never types,
// resizes or takes the claim, so nothing here accepts input: the view names
// who holds the shell, shows the daemon's redacted record and then live
// output, and says it is read-only.

const dots: Record<TerminalTone, string> = {
  live: "bg-success",
  failed: "bg-destructive",
  closed: "bg-faint",
  // 04d: a dropped connection is unconfirmed, not failed, so it is hollow
  // rather than red.
  unconfirmed: "border-[1.5px] border-muted-foreground",
}

function StatusDot({ tone }: { tone: TerminalTone }) {
  return <View className={cn("h-[7px] w-[7px] rounded-full", dots[tone])} />
}

// The claimant's lines wrap here, because a phone never resizes the shell.
// Consecutive lines are one text in the terminal face, so a long record is a
// handful of native views rather than one per line.
function OutputRows({ rows }: { rows: TerminalRow[] }) {
  const runs: Array<{ key: string, mark: string } | { key: string, lines: string[] }> = []
  for (const row of rows) {
    const last = runs.at(-1)
    if (row.kind === "line" && last && "lines" in last) last.lines.push(row.text)
    else if (row.kind === "line") runs.push({ key: row.key, lines: [row.text] })
    else runs.push({ key: row.key, mark: row.text })
  }
  return (
    <>
      {runs.map((run) => "mark" in run ? (
        <View key={run.key} className="my-1.5 border-t border-dashed border-border pt-1.5">
          <Text className="font-sans text-[11px] leading-[16px] text-muted-foreground">{run.mark}</Text>
        </View>
      ) : (
        <Text key={run.key} selectable className="font-mono text-[11px] leading-[17.6px] text-foreground">
          {run.lines.join("\n")}
        </Text>
      ))}
    </>
  )
}

function FollowSwitch({ on, disabled, onToggle }: { on: boolean, disabled: boolean, onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Follow output"
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onToggle}
      className={cn("min-h-tap flex-row items-center gap-2.5", disabled ? "opacity-45" : "active:opacity-70")}
    >
      <View className={cn("h-[22px] w-[38px] rounded-full", on ? "bg-primary" : "bg-muted")}>
        <View
          className={cn("absolute top-[2px] h-[18px] w-[18px] rounded-full", on ? "bg-primary-foreground" : "bg-foreground")}
          style={{ left: on ? 18 : 2 }}
        />
      </View>
      <Text className="font-sans text-[13px] text-strong">Follow output</Text>
    </Pressable>
  )
}

type WatchingProps = {
  // The session the terminal belongs to, as the thread names it.
  title: string
  watch: TerminalWatch
  // Whether the connection that watches is up. While it is down nothing on
  // screen is confirmed (04d).
  connected: boolean
  notice: ConnectionNotice | undefined
  onBack: () => void
  onRetry: () => void
}

// Restart on a desktop opens a new shell under the same id. The view starts
// over for it, following and with nothing counted, because what the old shell
// printed is not news about the new one.
export function WatchingScreen(props: WatchingProps) {
  const summary = watchedSummary(props.watch)
  return <WatchingView key={`${summary.terminalId}:${summary.openedAt}`} {...props} />
}

function WatchingView({ title, watch, connected, notice, onBack, onRetry }: WatchingProps) {
  const summary = watchedSummary(watch)
  const status = terminalStatus(summary, connected)
  const record = watch.state === "watching" ? watch.record : undefined
  // A reader scrolled away from the end reads a record that holds still: at
  // the bound each new line drops the oldest, which would move the text under
  // a viewport that keeps its offset. What lands meanwhile is counted, and the
  // view catches up at the end, by hand or by the jump.
  const [heldRecord, setHeldRecord] = useState<TerminalRecord | undefined>(undefined)
  const latestRecord = useRef(record)
  latestRecord.current = record
  const shown = record && heldRecord ? heldRecord : record
  const rows = useMemo(() => shown ? terminalRows(shown, connected) : [], [connected, shown])
  const closed = summary.state === "closed"

  const output = useRef<PageScrollerHandle>(null)
  const [follow, setFollow] = useState(followStart)
  // What landed since the last render, counted while the view does not follow.
  // Read from the lines received rather than the lines held: at the bound each
  // new line pushes an old one out. A new watch of the same shell (a reconnect
  // or Try again) replays what was counted, so the count clears and runs from
  // that watch's own first live line, even one that lands with the replay.
  const received = record?.received ?? 0
  const watchedAt = record?.watchedAt
  const seen = useRef({ watchedAt, received })
  useEffect(() => {
    // A count that went down can only be a new record, whatever its time.
    if (seen.current.watchedAt !== watchedAt || received < seen.current.received) {
      seen.current = { watchedAt, received: 0 }
      setFollow((current) => ({ ...current, unseen: 0 }))
    }
    const added = received - seen.current.received
    seen.current.received = received
    if (added > 0) setFollow((current) => followAfterOutput(current, added))
  }, [received, watchedAt])

  const jump = () => {
    setHeldRecord(undefined)
    setFollow(followJump)
    output.current?.scrollToEnd()
  }
  const toggle = () => {
    if (!follow.following) {
      setHeldRecord(undefined)
      output.current?.scrollToEnd()
    }
    setFollow(followToggle)
  }
  const scrolled = (atEnd: boolean) => {
    setHeldRecord(atEnd ? undefined : (held) => held ?? latestRecord.current)
    setFollow((current) => followAfterScroll(current, atEnd))
  }
  const jumpOffered = showJump(follow, closed)

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-3.5 pb-2 pt-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the thread"
          onPress={onBack}
          className="min-h-tap min-w-tap -ml-3 items-center justify-center active:opacity-70"
        >
          <Icon name="chevron-left" tone="primary" />
        </Pressable>
        <Text className="flex-1 font-sans text-[13px] text-muted-foreground" numberOfLines={1}>{title}</Text>
        <Badge label="read-only" tone="outline" pill />
      </View>

      <View className="gap-[7px] border-b border-border px-4 pb-[11px]">
        <View className="flex-row items-center gap-2">
          <Icon name="square-terminal" tone="muted" size={16} />
          <Text className="flex-1 font-mono text-[12px] text-strong" numberOfLines={1}>{terminalTitle(summary)}</Text>
          <Text className="font-mono text-[10.5px] text-faint">{terminalSize(summary)}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <StatusDot tone={status.tone} />
          <Text className="font-sans text-[12px] text-strong">{status.label}</Text>
          <View className="flex-1" />
          <Icon name="laptop" tone="muted" size={16} />
          <Text className="shrink font-sans text-[12px] text-muted-foreground" numberOfLines={1}>{claimantLine(summary, connected)}</Text>
        </View>
      </View>

      {notice ? <View className="px-3 pt-2.5"><ConnectionBanner notice={notice} /></View> : null}

      <View className="flex-1 bg-code">
        <PageScroller
          ref={output}
          testID="terminal-output"
          contentContainerClassName="px-3.5 py-3"
          followEnd={follow.following}
          onAtEndChange={scrolled}
        >
          {watch.state === "reading" ? <Text variant="meta">Reading the terminal.</Text> : null}
          {watch.state === "failed" ? (
            <Card className="gap-2 border-destructive">
              <Text className="font-sans-medium text-[13px] text-destructive">The terminal could not be read</Text>
              <Text variant="meta">{watch.message}</Text>
              <Button title="Try again" className="self-start" onPress={onRetry} disabled={!connected} />
            </Card>
          ) : null}
          <OutputRows rows={rows} />
        </PageScroller>
      </View>

      <View className="gap-0.5 border-t border-border px-4 pb-2 pt-1.5">
        <View className="flex-row items-center gap-2.5">
          <FollowSwitch on={follow.following && !closed} disabled={closed} onToggle={toggle} />
          <View className="flex-1" />
          {jumpOffered ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={follow.unseen > 0 ? `Jump to latest, ${follow.unseen} new` : "Jump to latest"}
              onPress={jump}
              className="h-11 flex-row items-center gap-[7px] rounded-full border border-border bg-card px-3.5 active:opacity-70"
            >
              <Icon name="arrow-down" tone="strong" size={16} />
              <Text className="font-sans text-[13px] text-strong">Jump to latest</Text>
              {follow.unseen > 0 ? <Text className="font-mono text-[10.5px] text-muted-foreground">{follow.unseen} new</Text> : null}
            </Pressable>
          ) : null}
        </View>
        <Text className="text-center font-sans text-[11px] leading-[16px] text-faint">Read-only. Only the claimant can type or resize.</Text>
      </View>
    </View>
  )
}

// Frame 04 (B): the way in from the thread. The block shows the tail, about
// seven lines, because a sideways scroll inside a scrolling thread fights the
// page; one tap opens the full view, and back returns here.
const tailLines = 7

export function TerminalBlock({ watch, connected, onOpen }: {
  watch: TerminalWatch
  connected: boolean
  onOpen: () => void
}) {
  const summary = watchedSummary(watch)
  const status = terminalStatus(summary, connected)
  const record = watch.state === "watching" ? watch.record : undefined
  const tail = useMemo(() => {
    if (!record) return []
    return terminalRows(record, connected).filter((row) => row.kind === "line").slice(-tailLines)
  }, [connected, record])
  const count = useMemo(() => record ? terminalLineCount(record) : 0, [record])
  const open = count > 0 ? `Show all ${count} ${count === 1 ? "line" : "lines"}` : "Open the terminal"
  return (
    <View className="overflow-hidden rounded-[14px] border border-border">
      <View className="gap-1.5 bg-card px-3 py-[9px]">
        <View className="flex-row items-center gap-2">
          <Icon name="square-terminal" tone="muted" size={16} />
          <Text className="flex-1 font-mono text-[11.5px] text-strong" numberOfLines={1}>{terminalTitle(summary)}</Text>
          <StatusDot tone={status.tone} />
          <Text className="font-sans text-[12px] text-strong">{status.label}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Icon name="laptop" tone="muted" size={16} />
          <Text className="shrink font-sans text-[12px] text-muted-foreground" numberOfLines={1}>{claimantLine(summary, connected)}</Text>
        </View>
      </View>
      {/* Seven lines tall at most. Wrapped lines can make the tail taller, so
          the block keeps its bottom and crops the top, as the design does:
          the newest output is the part that stays. */}
      <View className="max-h-[143px] justify-end overflow-hidden bg-code px-3 py-2.5">
        {watch.state === "reading" ? <Text variant="meta">Reading the terminal.</Text> : null}
        {watch.state === "failed" ? <Text variant="meta" className="text-destructive">{watch.message}</Text> : null}
        {record && tail.length === 0 ? <Text variant="meta">Nothing printed yet.</Text> : null}
        {tail.length > 0 ? (
          <Text className="font-mono text-[11px] leading-[17.6px] text-foreground">
            {tail.map((line) => line.text).join("\n")}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open}
        onPress={onOpen}
        className="min-h-tap flex-row items-center gap-2 border-t border-border bg-card px-3 active:opacity-70"
      >
        <Text className="flex-1 font-sans text-[13px] text-strong">{open}</Text>
        <Icon name="maximize-2" tone="muted" size={16} />
      </Pressable>
    </View>
  )
}
