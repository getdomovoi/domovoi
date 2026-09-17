import { Modal, Pressable, View } from "react-native"

import { cn } from "../lib/cn"
import { Button } from "./ui/button"
import { Icon, type IconName } from "./ui/icon"
import { Text } from "./ui/text"

// Frame 13. Five sources drawn, two built: the ones that move bytes. The
// other three are references to things the machine already has, and each
// says what it waits on rather than pretending to be a row.
const waiting: { icon: IconName, label: string, note: string }[] = [
  { icon: "layers", label: "File from the worktree", note: "desktop work: a phone holds no worktree to pick from" },
  { icon: "server", label: "Terminal output", note: "waits on a read-only terminal path, which a phone does not have yet" },
  { icon: "unplug", label: "A URL to fetch", note: "not built: an outbound fetch on a phone's word needs its own gate line" },
]

function Source({ icon, label, note, onPress }: { icon: IconName, label: string, note: string, onPress?: () => void }) {
  const body = (
    <>
      <Icon name={icon} tone={onPress ? "primary" : "faint"} size={18} />
      <View className="flex-1">
        <Text className={cn("text-[13px]", onPress ? "text-strong" : "text-muted-foreground")}>{label}</Text>
        <Text variant="note" className={cn(!onPress && "text-faint")}>{note}</Text>
      </View>
    </>
  )
  if (!onPress) return <View className="flex-row items-center gap-3 px-3 py-3 opacity-60">{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${note}`}
      onPress={onPress}
      className="flex-row items-center gap-3 px-3 py-3 active:opacity-70"
    >
      {body}
    </Pressable>
  )
}

export function AttachSheet({ open, machine, problem, onPickLibrary, onTakePhoto, onClose }: {
  open: boolean
  machine: string
  // The last refusal, stated here where the person chose the image, and
  // cleared by the next pick.
  problem: string
  onPickLibrary: () => void
  onTakePhoto: () => void
  onClose: () => void
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close" onPress={onClose} />
      <View className="gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="flex-row items-center gap-2">
          <Text variant="nav" className="flex-1">What you can attach</Text>
          <Button title="Done" variant="ghost" onPress={onClose} className="px-2" />
        </View>
        {problem ? <Text className="text-[11.5px] text-destructive">{problem}</Text> : null}
        <View className="divide-y divide-border rounded-xl border border-border">
          <Source icon="image" label="Photo or screenshot" note={`up to 1.5 MB and 2048 px, uploaded to ${machine} and not stored here`} onPress={onPickLibrary} />
          <Source icon="camera" label="Take a photo" note="one shot, sent with the turn, same bound" onPress={onTakePhoto} />
          {waiting.map((source) => <Source key={source.label} {...source} />)}
        </View>
      </View>
    </Modal>
  )
}
