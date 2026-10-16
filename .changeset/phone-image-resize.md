---
"@getdomovoi/mobile": patch
---

Resize phone images instead of refusing them, and open the photo picker reliably.

An image over 2048 px on its long side is drawn again on the device at 2048 with
expo-image-manipulator, kept a PNG when the PNG fits 1.5 MB and otherwise sent as a JPEG at
quality 0.8. Location and other metadata are removed from every image that carries any. An image
still over 1.5 MB after that is refused on the phone, and the daemon's bounds are unchanged. The
chip says "resized from W x H". The picker's and the encoder's copies in the app cache are deleted
once read. The attach sheet now closes before the photo library or camera opens, a picker that
fails to open is stated, and a refusal shows on the composer once the sheet has gone. The phone
app needs a native rebuild for expo-image-manipulator.
