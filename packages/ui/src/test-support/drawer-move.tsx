import { useState, type ComponentProps } from "react"

import { Thread } from "../thread"

// Stands in for the sessions drawer's "Move to another machine", the route
// that opens the composer's machine menu. v2 draws no machine control in the
// composer, so a test reaches the menu the way a person does.
export function ThreadWithDrawerMove(props: ComponentProps<typeof Thread>) {
  const [request, setRequest] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setRequest((current) => current + 1)}>Move to another machine</button>
      <Thread {...props} machineMenuRequest={request} />
    </>
  )
}
