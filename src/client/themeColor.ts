/**
 * A CSS colour flattened into the form a Monaco theme's data can hold.
 *
 * A Monaco theme's `colors` map is not a stylesheet. The two ids that carry the
 * editor's own default foreground and background are lifted out of it and pushed
 * into the *token colour* table (`StandaloneTheme.tokenTheme`), and that table
 * validates every value with `/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/`, throwing
 * `Illegal value for token color: …` for anything else (`ColorMap.getId` in
 * `vs/editor/common/languages/supports/tokenization.ts`). A three-digit `#fff`
 * is a perfectly good CSS colour and not a value that table can hold.
 *
 * VS Code never meets that edge, because its theme data arrives from validated
 * JSON and is flattened on the way in by `normalizeColor`
 * (`vs/workbench/services/themes/common/colorThemeData.ts`), which expands the
 * shorthand and keeps six or eight digits. This plugin reads the DeepSeek
 * Harness alias tokens off the live page instead, so the same flattening has to
 * happen here: `--dsw-alias-bg-base` is `#fff` in the light theme, and the whole
 * diff pane used to disappear because of it.
 *
 * `normalizeColor` returns `undefined` for a colour it cannot read; so does this,
 * and the caller falls back to the built-in default rather than handing Monaco a
 * value it will reject or silently render as red (`Color.fromHex`).
 * @param value - one CSS colour, as a computed custom property returns it.
 * @returns `#RRGGBB` or `#RRGGBBAA`, or `null` when Monaco cannot hold the value.
 */
export function toThemeColor(value: string): string | null {
  const short = /^#([\da-f])([\da-f])([\da-f])([\da-f])?$/i.exec(value)
  if (short !== null) {
    const [, r, g, b, a] = short
    return `#${r}${r}${g}${g}${b}${b}${a === undefined ? '' : a + a}`
  }
  return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value) ? value : null
}
