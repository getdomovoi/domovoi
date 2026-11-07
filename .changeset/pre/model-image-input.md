---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Each model says whether it takes image input. `runtime.models` entries carry `imageInput`,
`true` when an image attachment on a send to that model is delivered and `false` when it is not;
the daemon fills it from the same rule the send uses, the adapter's vision capability. A send with
images to a model that takes none is still refused whole. The error message now names the model
and the image count, and the error data keeps the shape released clients parse. The attach sheet's
code is the exported constant `modelImageInputRefusalCode`.
