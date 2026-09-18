/**
 * Colour-flattening checks for the Monaco theme.
 *
 * `src/client/themeColor.ts` exists because the DeepSeek Harness tokens are read
 * as *CSS* colours and handed to Monaco as *theme data*, and the two accept
 * different spellings. The failure mode is invisible: a value Monaco rejects
 * throws while the diff body mounts, so the pane renders nothing at all and the
 * only clue is a console error. `--dsw-alias-bg-base` is `#fff` in the light
 * theme, which is exactly that value.
 *
 * Run with `pnpm test`; the module is bundled on the fly so the test reads the
 * same source the browser half does.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'src', 'client', 'themeColor.ts')
const stage = await mkdtemp(path.join(tmpdir(), 'scm-theme-color-'))
const bundled = path.join(stage, 'themeColor.cjs')
await build({
  entryPoints: [source],
  outfile: bundled,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  logLevel: 'error',
})
const { toThemeColor } = await import(pathToFileURL(bundled).href)

/** The rule Monaco's token-colour table applies, from `tokenization.ts`. */
const MONACO_TOKEN_COLOR = /^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/

/** Every case: a token value as the page resolves it, and what Monaco must get. */
const cases = [
  // The reported bug: the light theme's base background is three digits.
  ['#fff', '#ffffff'],
  // Four digits carry the alpha, and both halves of every digit are doubled.
  ['#0af8', '#00aaff88'],
  // Six and eight digits are already theme data and pass through untouched.
  ['#0f1115', '#0f1115'],
  ['#0000000a', '#0000000a'],
  ['#151517', '#151517'],
  ['#ffffff0f', '#ffffff0f'],
  // Case is not significant to either side, so it is not rewritten.
  ['#FFF', '#FFFFFF'],
  ['#AbCdEf', '#AbCdEf'],
  // Unreadable values are refused rather than passed on: Monaco throws on the
  // two that reach its token table and silently paints `Color.red` with the rest.
  ['', null],
  ['white', null],
  ['rgb(255, 255, 255)', null],
  ['transparent', null],
  ['oklch(0.7 0.1 200)', null],
  // Near misses of the hex forms.
  ['#ff', null],
  ['#fffff', null],
  ['#fffffff', null],
  ['#gggggg', null],
  ['fff', null],
  ['#fff ', null],
]

for (const [value, expected] of cases) {
  assert.equal(
    toThemeColor(value),
    expected,
    `toThemeColor(${JSON.stringify(value)}) should be ${JSON.stringify(expected)}`,
  )
}

// The point of the exercise: everything the function returns is a value Monaco's
// token-colour table accepts, and nothing it refuses is one.
for (const [value, expected] of cases) {
  if (expected === null) continue
  assert.match(expected, MONACO_TOKEN_COLOR, `${expected} is not a colour Monaco can hold`)
}

// A token that is unset reaches `token()` as an empty string, which has to be
// refused so the caller's built-in default applies.
assert.equal(toThemeColor(''), null)

await rm(stage, { recursive: true, force: true })
console.log(`theme colour: ${cases.length} cases pass`)
