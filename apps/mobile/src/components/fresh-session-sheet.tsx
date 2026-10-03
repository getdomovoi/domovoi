import { useState } from "react"
import { Modal, Pressable, TextInput, View } from "react-native"

import type { PhoneRefusal } from "../session-refusal"
import { useTheme } from "../theme/theme-provider"
import { RefusalCard } from "./refusal-card"
import { Button } from "./ui/button"
import { Text } from "./ui/text"

// A start the daemon refused over a repository git filter shows as its
// refusal card in place of the problem line.
export function FreshSessionSheet({ open, project, starting, problem, refusal, onSeeHeldBack, onStart, onClose }: {
  open: boolean
  project: string
  starting: boolean
  problem: string
  refusal?: PhoneRefusal | undefined
  onSeeHeldBack?: (() => void) | undefined
  onStart: (prompt: string) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const { palette } = useTheme()
  const usable = prompt.trim().length > 0
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close" onPress={onClose} />
      <View className="gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="flex-row items-center gap-2">
          <Text variant="nav" className="flex-1">Start a session</Text>
          <Button title="Cancel" variant="ghost" onPress={onClose} className="px-2" disabled={starting} />
        </View>
        <Text variant="note">Starts in the open project “{project}” using the machine provider's default runtime.</Text>
        {refusal && onSeeHeldBack
          ? <RefusalCard refusal={refusal} onSeeHeldBack={onSeeHeldBack} />
          : problem ? <Text className="text-[11.5px] text-destructive">{problem}</Text> : null}
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
        <Button
          title="Start"
          variant="primary"
          shape="block"
          disabled={starting || !usable}
          onPress={() => { if (usable) onStart(prompt.trim()) }}
        />
      </View>
    </Modal>
  )
}
