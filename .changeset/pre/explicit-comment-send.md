---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Preview comments can now be sent explicitly. `session.send` takes an optional `review`: the ids
of the open comments this message sends (at most 20) and, as `buildBasis`, the preview the person
chose for the agent to build on. A message that carries a review delivers only the comments it
names, so a half-written comment does not steer that turn. `review: { annotationIds: [] }` is
the explicit send of nothing: no comment and no build basis. The review is checked when the message
is sent, when it is queued and when a queued message is released: a comment that is not open on
the session, or a build basis that is not one of its previews, refuses the whole message rather
than sending less than the person chose. The refusal carries error data
`{ kind: "session-review-refused", reason: "comment-unavailable" | "build-basis-unavailable" }`,
so a queued message that meets it at release is refused, as attachment and skill faults are. Only the named comments' crops are read. The build basis
is never dropped for the payload budget; comments still are, oldest first, as before. A turn's
delivery record names the build basis it carried. A queued message keeps its review across a
restart.

Ruling Q402: until desktop, web, phone, tablet and the command line send `review`, a message
without one keeps today's behaviour: every open comment of its session attaches, and no build
basis. That legacy default lives in one function, `legacyOpenCommentReview`, and is removed before
protocol 0.8.0 ships, when a message without a review will send no comment. Phone and tablet keep
the same methods: `review` rides on `session.send`, which they already hold. The first message
after a cross-provider handoff follows the same rule: with a review, the handoff context carries
no current comment and only the review's comments reach the provider; without one, the handoff
still carries every open comment, as before.
