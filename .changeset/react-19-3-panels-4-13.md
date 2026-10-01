---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

Move the shared ui and the web and desktop clients to React 19.3.0 and react-resizable-panels
4.13.3. React 19.3 renders transitions independently instead of entangling them into one render,
and enables its Trusted Types integration. The phone stays on the React version its Expo SDK
bundles.
