import { useRef } from "react"
import { Modal, Platform, Pressable, View } from "react-native"

import { modelImageInputRefusalCode } from "@getdomovoi/protocol"

import { modelImagesLine, type ModelImages } from "../attachments"
import { cn } from "../lib/cn"
import { Button } from "./ui/button"
import { Icon, type IconName } from "./ui/icon"
import { Text } from "./ui/text"

// Frame 13. Five sources drawn, two built: the ones that move bytes. The
// other three are references to things the machine already has, and each
// says what it waits on rather than pretending to be a row.
const waiting: { icon: IconName, label: string, note: string }[] = [
  { icon: "layers", label: "File from the worktree", note: "desktop work: a phone holds no worktree to pick from" },
  { icon: "server", label: "Terminal output", note: "not built: a phone reads a terminal but cannot pick its output to attach" },
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

// Frame 13b (guard A): an image source the session's model cannot take. It is
// stated, not tappable, with the machine that would refuse it and the code.
function LockedSource({ icon, label, machine }: { icon: IconName, label: string, machine: string }) {
  return (
    <View
      className="flex-row items-center gap-3 px-3 py-3"
      accessible
      accessibilityLabel={`${label}: locked for this model, refused by ${machine} · ${modelImageInputRefusalCode}`}
    >
      <Icon name={icon} tone="faint" size={18} />
      <View className="flex-1">
        <Text className="text-[13px] text-muted-foreground">{label}</Text>
        <Text variant="note">Locked for this model.</Text>
        <Text variant="machine" className="mt-0.5 text-faint">{`refused by ${machine} · ${modelImageInputRefusalCode}`}</Text>
      </View>
      <Icon name="ban" tone="faint" size={15} />
    </View>
  )
}

export function AttachSheet({ open, machine, problem, images, onPickLibrary, onTakePhoto, onClose }: {
  open: boolean
  machine: string
  // The last refusal, stated here where the person chose the image, and
  // cleared by the next pick.
  problem: string
  // The session's model and what its harness reports about image input.
  // Absent when the screen has no session runtime to name.
  images?: ModelImages | undefined
  onPickLibrary: () => void
  onTakePhoto: () => void
  onClose: () => void
}) {
  // Only a model reported to take no images locks the sources. Not knowing
  // leaves them open; the daemon still refuses a send the model cannot take.
  const locked = images?.imageInput === false
  // Walk F23: on iOS this sheet is a presented view controller, and iOS will
  // not present the photo library or the camera over one that is still on
  // screen or sliding out. Asked to, it presents nothing and the picker's
  // promise says nothing. So a choice closes the sheet and waits for iOS to
  // report it gone (onDismiss, iOS only) before opening the picker. Android
  // opens its picker as a separate activity and has no such callback.
  const chosen = useRef<(() => void) | undefined>(undefined)
  const choose = (pick: () => void) => () => {
    onClose()
    if (Platform.OS !== "ios") {
      pick()
      return
    }
    chosen.current = pick
  }
  const dismissed = () => {
    const pick = chosen.current
    chosen.current = undefined
    pick?.()
  }
  return (
    <Modal testID="attach-sheet" visible={open} transparent animationType="slide" onRequestClose={onClose} onDismiss={dismissed}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close" onPress={onClose} />
      <View className="gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="flex-row items-center gap-2">
          <Text variant="nav" className="flex-1">What you can attach</Text>
          <Button title="Done" variant="ghost" onPress={onClose} className="px-2" />
        </View>
        {images ? (
          <View className="flex-row items-center gap-2 px-1">
            <Text variant="machine" className="text-strong">{images.model}</Text>
            <Text className="flex-1 text-[11.5px] text-muted-foreground">{modelImagesLine(images.imageInput)}</Text>
          </View>
        ) : null}
        {problem ? <Text className="text-[11.5px] text-destructive">{problem}</Text> : null}
        <View className="divide-y divide-border rounded-xl border border-border">
          {locked ? <>
            <LockedSource icon="image" label="Photo or screenshot" machine={machine} />
            <LockedSource icon="camera" label="Take a photo" machine={machine} />
          </> : <>
            <Source icon="image" label="Photo or screenshot" note={`up to 1.5 MB and 2048 px, uploaded to ${machine} and not stored here`} onPress={choose(onPickLibrary)} />
            <Source icon="camera" label="Take a photo" note="one shot, sent with the turn, same bound" onPress={choose(onTakePhoto)} />
          </>}
          {waiting.map((source) => <Source key={source.label} {...source} />)}
        </View>
      </View>
    </Modal>
  )
}
