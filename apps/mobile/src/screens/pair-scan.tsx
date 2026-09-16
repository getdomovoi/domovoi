import { decodePairingPayload, type PairingPayload } from "@getdomovoi/protocol"
import { CameraView, useCameraPermissions, type PermissionResponse } from "expo-camera"
import { useCallback, useState, type ComponentType } from "react"
import { TextInput, View } from "react-native"

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
}: {
  permission: PermissionResponse | null
  requestPermission: () => Promise<PermissionResponse>
  Scanner?: PairScanner
  onPaired: (payload: PairingPayload) => void
  onCancel: () => void
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
      <View className="flex-1 gap-[14px] px-3">
        {found ? (
          <Card className="gap-3">
            <Text variant="label">Machine</Text>
            <Text className="text-[13px]">{machineName(found)}</Text>
            <Text variant="note">
              This credential lets the phone send work, answer gates and open terminals on that machine, and nothing else. It stays in this phone's keychain.
            </Text>
            <Button title="Pair with this machine" variant="primary" shape="block" onPress={() => onPaired(found)} />
            <Button title="Scan again" variant="ghost" shape="block" onPress={() => { setRead(undefined); setPasted("") }} />
          </Card>
        ) : cameraReady && !cameraRefused ? (
          <View className="min-h-[280px] flex-1 overflow-hidden rounded-xl border border-border">
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
      </View>
    </View>
  )
}

export function usePairCameraPermission() {
  return useCameraPermissions()
}
