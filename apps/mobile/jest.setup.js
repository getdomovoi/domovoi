// React Native's index hands out components through lazy getters, so the first
// render in a test file is what requires ScrollView, Modal, Image and the rest,
// and on a runner with no transform cache that first require compiles their
// whole module graph. That landed inside whichever test rendered first and ran
// it past the 5 s test timeout on Windows CI. Loading them here, once per file
// before any test starts, keeps that one-time cost out of every test's budget.
const ReactNative = require("react-native")

for (const name of ["Text", "ScrollView", "Modal", "Image", "TextInput", "Pressable", "ActivityIndicator", "KeyboardAvoidingView"]) {
  void ReactNative[name]
}
