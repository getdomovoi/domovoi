import { useState } from "react"
import { Modal, Pressable, TextInput, View } from "react-native"
import type { PermissionMode } from "@getdomovoi/protocol"

import { cn } from "../lib/cn"
import { useTheme } from "../theme/theme-provider"
import { Button } from "./ui/button"
import { Text } from "./ui/text"

// What a phone start is: the machine, repository, provider and model of the
// session the person is looking at, one field for what they want done, and
// the mode. Not a launcher. Plan is the default because it is the one mode
// whose result nobody has to be watching for.
const modes: { id: PermissionMode, label: string, note: string }[] = [
  { id: "plan", label: "Plan", note: "The agent reads and proposes; nothing is written. It comes back as a proposal you approve." },
  { id: "ask", label: "Ask", note: "Every write waits for you. From a phone that is a stalled turn by the time you look." },
  { id: "build", label: "Build", note: "The agent writes to the worktree with nobody reading. Gates still stop it." },
]

export function StartLikeSheet({ open, like, starting, problem, onStart, onClose }: {
  open: boolean
  like: { title: string, machine: string, runtime: string }
  starting: boolean
  problem: string
  onStart: (prompt: string, mode: PermissionMode) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const [mode, setMode] = useState<PermissionMode>("plan")
  const { palette } = useTheme()
  const usable = prompt.trim().length > 0
  const chosen = modes.find((candidate) => candidate.id === mode)!
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close" onPress={onClose} />
      <View className="gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="flex-row items-center gap-2">
          <Text variant="nav" className="flex-1">Start another like this one</Text>
          <Button title="Cancel" variant="ghost" onPress={onClose} className="px-2" disabled={starting} />
        </View>
        <Text variant="note">
          Same machine, repository, provider and model as “{like.title}”: {like.machine} · {like.runtime}.
        </Text>
        {problem ? <Text className="text-[11.5px] text-destructive">{problem}</Text> : null}
        <TextInput
          multiline
          autoFocus
          editable={!starting}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should it do?"
          placeholderTextColor={palette.faint}
          selectionColor={palette.primary}
          accessibilityLabel="What to do"
          className="min-h-[88px] rounded-lg border border-border bg-code px-2.5 py-2 font-sans text-[12px] text-foreground"
        />
        <View className="gap-1.5">
          <View className="flex-row gap-1.5">
            {modes.map((candidate) => {
              const selected = candidate.id === mode
              return (
                <Pressable
                  key={candidate.id}
                  accessibilityRole="button"
                  accessibilityLabel={candidate.label}
                  accessibilityState={{ selected }}
                  onPress={() => setMode(candidate.id)}
                  disabled={starting}
                  className={cn(
                    "min-h-tap flex-1 items-center justify-center rounded-lg border",
                    selected ? "border-primary bg-primary/15" : "border-border bg-card",
                  )}
                >
                  <Text className={cn("font-sans-medium text-[12.5px]", selected ? "text-primary" : "text-muted-foreground")}>
                    {candidate.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <Text variant="note">{chosen.note}</Text>
        </View>
        <Button
          title="Start"
          variant="primary"
          shape="block"
          disabled={starting || !usable}
          onPress={() => { if (usable) onStart(prompt.trim(), mode) }}
        />
      </View>
    </Modal>
  )
}
