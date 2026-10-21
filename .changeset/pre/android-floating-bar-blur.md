---
"@getdomovoi/mobile": patch
---

Blur what sits behind the floating bars on Android.

expo-blur's Android BlurView blurs one named view, its `blurTarget`, and draws no blur when it has
none. The tab bar, composer, decision bar, denial bar and Tools footer had no target, so on Android
they showed only the 60 percent wash over sharp content. Each screen now wraps the content those
bars float over in a `BlurBackdrop` (expo-blur's `BlurTargetView`), and every `FloatingBar` reads
that target from a provider at the root. A bar is never drawn inside the target it blurs, because a
blur that samples itself has nothing stable to sample. iOS draws as before: it blurs whatever is
behind the bar without a target, so the backdrop is a plain view there and no target is passed.
