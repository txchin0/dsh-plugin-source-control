/**
 * Type shims for the binary assets the bundle inlines.
 *
 * `build.mjs` maps `.woff` (and its siblings) to esbuild's `dataurl` loader, so
 * importing one yields the `data:` URL the generated icon stylesheet needs for
 * its `@font-face`. The lifted theme JSON needs no shim of its own:
 * `resolveJsonModule` types it from the file.
 */
declare module '*.woff' {
  const url: string
  export default url
}
