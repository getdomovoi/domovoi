---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Preview comments now reach the agent only when a person sends them. `session.send` takes an
optional `review`: the ids of the open comments this message sends (at most 20) and, as
`buildBasis`, the preview the person chose for the agent to build on. The daemon no longer adds
every open comment to every turn, so a half-written comment does not steer one; a message
without a review sends no comment and no build basis. The review is checked when the message is
sent, when it is queued and when a queued message is released: a comment that is not open on
the session, or a build basis that is not one of its previews, refuses the whole message rather
than sending less than the person chose. Only the named comments' crops are read. The build basis
is never dropped for the payload budget; comments still are, oldest first, as before. A turn's
delivery record names the build basis it carried. A queued message keeps its review across a
restart.

Clients built before this change still connect at protocol 0.8.0 but send no review, so their
comments stop reaching the agent until they send one. Phone and tablet keep the same methods:
`review` rides on `session.send`, which they already hold. A cross-provider handoff still carries
the session's open comments as session state.
