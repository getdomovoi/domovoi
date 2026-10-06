import { Fragment, useEffect, useMemo, useRef, useState } from "react"
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
// Consecutive lines are one text block with a span per line, so a long record
// is a handful of native views rather than one per line.
function OutputRows({ rows }: { rows: TerminalRow[] }) {
  const runs: Array<{ key: string, mark: TerminalRow } | { key: string, lines: TerminalRow[] }> = []
  for (const row of rows) {
    const last = runs.at(-1)
    if (row.kind === "line" && last && "lines" in last) last.lines.push(row)
    else if (row.kind === "line") runs.push({ key: row.key, lines: [row] })
    else runs.push({ key: row.key, mark: row })
  }
  return (
    <>
      {runs.map((run) => "mark" in run ? (
        <View key={run.key} className="my-1.5 border-t border-dashed border-border pt-1.5">
          <Text className="font-sans text-[11px] leading-[16px] text-muted-foreground">{run.mark.text}</Text>
        </View>
      ) : (
        <Text key={run.key} selectable className="font-mono text-[11px] leading-[17.6px] text-foreground">
          {run.lines.map((line, index) => (
            <Fragment key={line.key}>
              {index > 0 ? "\n" : null}
              <Text>{line.text}</Text>
            </Fragment>
          ))}
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

export function WatchingScreen({
  title,
  watch,
  connected,
  notice,
  onBack,
  onRetry,
}: {
  // The session the terminal belongs to, as the thread names it.
  title: string
  watch: TerminalWatch
  // Whether the connection that watches is up. While it is down nothing on
  // screen is confirmed (04d).
  connected: boolean
  notice: ConnectionNotice | undefined
  onBack: () => void
  onRetry: () => void
}) {
  const summary = watchedSummary(watch)
  const status = terminalStatus(summary, connected)
  const record = watch.state === "watching" ? watch.record : undefined
  const rows = useMemo(() => record ? terminalRows(record, connected) : [], [connected, record])
  const lineCount = useMemo(() => record ? terminalLineCount(record) : 0, [record])
  const closed = summary.state === "closed"

  const output = useRef<PageScrollerHandle>(null)
  const [follow, setFollow] = useState(followStart)
  // What landed since the last render, counted while the view does not follow.
  const seenLines = useRef(lineCount)
  useEffect(() => {
    const added = lineCount - seenLines.current
    seenLines.current = lineCount
    if (added > 0) setFollow((current) => followAfterOutput(current, added))
  }, [lineCount])

  const jump = () => {
    setFollow(followJump)
    output.current?.scrollToEnd()
  }
  const toggle = () => {
    if (!follow.following) output.current?.scrollToEnd()
    setFollow(followToggle)
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
          onAtEndChange={(atEnd) => setFollow((current) => followAfterScroll(current, atEnd))}
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
      <View className="bg-code px-3 py-2.5">
        {watch.state === "reading" ? <Text variant="meta">Reading the terminal.</Text> : null}
        {watch.state === "failed" ? <Text variant="meta" className="text-destructive">{watch.message}</Text> : null}
        {record && tail.length === 0 ? <Text variant="meta">Nothing printed yet.</Text> : null}
        {tail.length > 0 ? (
          <Text className="font-mono text-[11px] leading-[17.6px] text-foreground" numberOfLines={tailLines * 3}>
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
