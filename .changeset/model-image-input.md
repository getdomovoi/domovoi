---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Each model says whether it takes image input. `runtime.models` entries carry `imageInput`,
`true` when an image attachment on a send to that model is delivered and `false` when it is not;
today that follows the adapter's vision capability. A send with images to a model that takes
none is still refused whole, and the refusal now names the model and the image count with the
code `attach.image.model_no_input`, so a composer can say which model the images cannot go to.
