---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
"@getdomovoi/mobile": minor
---

A message without a `review` sends no comment. Ruling Q402: the legacy default that attached every
open comment of the session to a `session.send` carrying no `review` is removed before protocol
0.8.0 ships. On the wire, `session.send` without `review` now composes the same provider prompt
as `review: { annotationIds: [] }`: no comment, no build basis, and a handoff context that lists
no open annotation. The daemon never fills in a review; the only comments that reach the agent are
the ones the message names. `review` stays optional rather than required, so a daemon cannot
invent one and a client built before the field keeps sending words; such a client loses the
comments it never named.

Every client now states its review. Desktop and web (`packages/ui`) and the phone and tablet
(`apps/mobile`) list a session's comments as open without yet offering the drawn choice of which
to send, so a send names every open comment of that session, read from the latest snapshot at the
moment of sending: `openCommentReviewFor` in `@getdomovoi/protocol` keeps the newest up to the 20
a message may carry, the order the daemon delivered under the old default, and names no build
basis. When more comments are open than that, the review also carries `omittedOverLimit`, the
count of older open comments it left out. The wire accepts the count only on a full review, as a
positive whole number up to 1,000,000. The daemon records it in the sent message's
`providerPromptDelivery.annotations` (`availableCount` and `omitted.limit`) and tells the agent
the count, but composes only the comments the review names; the count never selects a comment. A
queued message keeps the count until release. Desktop and web show the record with the existing
delivery note line, and the phone shows the same sentence under the sent message, so a comment
that missed the turn stays visible after the send succeeds. A message that starts a session the
client just created, and a `DomovoiClient.sendMessage` given no review, send `{ annotationIds: [] }` explicitly rather than leaving the field out. The
chosen preview stays a viewer bookmark until the dock sends it (ruling Q342 A). The command line
sends no message.

A queued message persisted before this change with no review is released as it was queued and
sends no comment.
