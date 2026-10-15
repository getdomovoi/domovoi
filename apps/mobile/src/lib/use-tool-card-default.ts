import { useCallback, useEffect, useRef, useState } from "react"
import * as SecureStore from "expo-secure-store"

import { freshToolCardDefault, parseToolCardDefault, toolCardDefaultKey, type ToolCardDefault } from "../tool-cards"

// The tool card default lives on this device beside the appearance choice
// (theme-provider.tsx), in the same store. It is a preference, not a secret;
// the store is used because it is the one the app already keeps settings in.
export function useToolCardDefault(): [ToolCardDefault, (next: ToolCardDefault) => void] {
  const [value, setValue] = useState<ToolCardDefault>(freshToolCardDefault)
  // A choice made before the stored one has loaded wins over it.
  const chosen = useRef(false)

  useEffect(() => {
    let live = true
    void SecureStore.getItemAsync(toolCardDefaultKey).then((stored) => {
      if (live && !chosen.current) setValue(parseToolCardDefault(stored))
    })
    return () => { live = false }
  }, [])

  const choose = useCallback((next: ToolCardDefault) => {
    chosen.current = true
    setValue(next)
    void SecureStore.setItemAsync(toolCardDefaultKey, next)
  }, [])

  return [value, choose]
}
