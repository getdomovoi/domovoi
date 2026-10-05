---
"@getdomovoi/desktop": patch
"@getdomovoi/ui": patch
---

A turn-on of the tailnet switch, including "Renew now", reads the status after
it once the switch is released, under the same 15 second deadline as a
turn-off. A turn-on is done once the certificate is stored, the record written,
the daemon restarted and confirmed on the tailnet, and renewal scheduled. A
stalled read of the certificate's expiry after that no longer keeps the switch
busy, so turning off and renewal are no longer refused as busy until the read
settles. When that read does not answer in time, the turn-on is answered as
done, not as failed: the card says Not known and "Turned on. The desktop did
not answer when asked what the switch reads now.", keeps the switch disabled,
and offers "Check again" until a read answers. When that read fails before the
deadline, the card says "Turned on. Reading what the switch reads now failed:"
followed by the read's own words. A refusal, a failed store, a failed restart
and anything that throws before the change is done are still reported as the
turn-on failing, with the same rollback as before. The card refuses a turn-on
answer that names undeleted certificate files, which only a turn-off leaves.
