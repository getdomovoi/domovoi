import { decodePairingPayload, phoneAndTabletPromise, phoneAndTabletPromiseGap, type PairingPayload } from "@getdomovoi/protocol"
import { CameraView, useCameraPermissions, type PermissionResponse } from "expo-camera"
import { useCallback, useState, type ComponentType } from "react"
import { TextInput, View } from "react-native"

import { PageScroller } from "../components/page-scroller"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { colors } from "../theme/tokens.generated"

// Pairing by camera. The QR carries a daemon address and a credential minted
// by `domovoid pair --client phone`; the phone reads it, names the machine and
// asks once before it connects. The token never appears on screen. A phone
// whose camera is refused pastes the same text instead, read the same way.

export type PairScanResult =
  | { ok: true, payload: PairingPayload }
  | { ok: false, reason: string }

export function readPairingScan(text: string): PairScanResult {
  try {
    return { ok: true, payload: decodePairingPayload(text) }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "The pairing code could not be read" }
  }
}

// The camera is injected so a test can hand the screen the text a QR would
// carry without a device.
export type PairScanner = ComponentType<{ onScanned: (text: string) => void }>

function CameraScanner({ onScanned }: { onScanned: (text: string) => void }) {
  return (
    <CameraView
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={(result) => onScanned(result.data)}
    />
  )
}

function machineName(payload: PairingPayload): string {
  if (payload.label) return payload.label
  try { return new URL(payload.url).hostname } catch { return payload.url }
}

export function PairScanScreen({
  permission,
  requestPermission,
  Scanner = CameraScanner,
  onPaired,
  onCancel,
  bottomInset = 0,
}: {
  permission: PermissionResponse | null
  requestPermission: () => Promise<PermissionResponse>
  Scanner?: PairScanner
  onPaired: (payload: PairingPayload) => void
  onCancel: () => void
  // What the floating tab bar covers, so Cancel and the paste field sit
  // above it and the keyboard can push the field into view.
  bottomInset?: number
}) {
  const [read, setRead] = useState<PairScanResult>()
  const [pasted, setPasted] = useState("")
  // One handler for the camera's lifetime: a camera reports frames on its own
  // schedule, and a new function each render would re-arm it each time.
  const onScanned = useCallback((text: string) => setRead(readPairingScan(text)), [])
  const cameraRefused = permission !== null && !permission.granted && !permission.canAskAgain
  const cameraReady = permission?.granted === true
  const found = read?.ok ? read.payload : undefined

  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">Pair a machine</Text>
        <Text variant="meta" className="mt-[3px]">Scan the code the machine shows, or paste it.</Text>
      </View>
      <PageScroller contentContainerClassName="gap-[14px] px-3" bottomInset={bottomInset} keyboardShouldPersistTaps="handled">
        {found ? (
          <Card className="gap-3">
            <Text variant="label">Machine</Text>
            <Text className="text-[13px]">{machineName(found)}</Text>
            {/* The phone can check the credential's shape, not its scope: a
                daemon's own credential has the same shape and can do anything
                on that machine. The promise is conditional and says so. */}
            <Text variant="label">A paired phone can</Text>
            {phoneAndTabletPromise.map((line) => <Text key={line} variant="note">{line}</Text>)}
            {/* The first line is the machine's word, and this app does not
                keep all of it yet. The text comes from the protocol so this
                screen and the machine's pairing card say the same thing. */}
            <Text variant="note">{phoneAndTabletPromiseGap}</Text>
            <Text variant="note">
              That is the scope of a credential the machine minted with domovoid pair --client phone; the daemon refuses everything else to it. The phone cannot tell that credential from the machine's own, which can do anything on that machine. Either way it stays in this phone's keychain.
            </Text>
            <Button title="Pair with this machine" variant="primary" shape="block" onPress={() => onPaired(found)} />
            <Button title="Scan again" variant="ghost" shape="block" onPress={() => { setRead(undefined); setPasted("") }} />
          </Card>
        ) : cameraReady && !cameraRefused ? (
          <View className="h-[300px] overflow-hidden rounded-xl border border-border">
            <Scanner onScanned={onScanned} />
          </View>
        ) : cameraRefused ? (
          <Card className="gap-2">
            <Text variant="label">Camera refused</Text>
            <Text variant="note">This phone has refused the camera to Domovoi. Allow it in the phone's settings, or paste the pairing code below.</Text>
          </Card>
        ) : (
          <Card className="gap-2">
            <Text variant="note">Domovoi needs the camera to read the pairing code on the machine's screen.</Text>
            <Button title="Allow the camera" variant="primary" shape="block" onPress={() => void requestPermission()} />
          </Card>
        )}
        {read && !read.ok ? (
          <Text className="px-1 font-sans-medium text-[11.5px] text-destructive">{read.reason}</Text>
        ) : null}
        {found ? null : (
          <Card className="gap-1.5">
            <Text variant="label">Or paste the pairing code</Text>
            <TextInput
              accessibilityLabel="Pairing code"
              value={pasted}
              onChangeText={(text) => {
                setPasted(text)
                setRead(text.trim() ? readPairingScan(text) : undefined)
              }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="domovoi-pair:1:…"
              placeholderTextColor={colors.dark.faint}
              selectionColor={colors.dark.primary}
              className="min-h-tap rounded-md border border-border bg-code px-3 font-mono text-[11px] text-foreground"
            />
          </Card>
        )}
        <Button title="Cancel" variant="ghost" shape="block" onPress={onCancel} />
      </PageScroller>
    </View>
  )
}

export function usePairCameraPermission() {
  return useCameraPermissions()
}
