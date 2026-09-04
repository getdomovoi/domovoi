// Metro turns a font file import into a registered asset id for expo-font.
declare module "*.ttf" {
  const asset: number
  export default asset
}
