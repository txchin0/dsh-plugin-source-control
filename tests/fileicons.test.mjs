/**
 * File-icon checks for the Changes list.
 *
 * The icon a row draws is decided by a CSS cascade, not by a lookup: the class
 * list a path produces carries the precedence in its *length*, so a wrong
 * answer still draws *something* — a plausible-looking icon for the wrong kind
 * of file. That is the same failure shape as a wrong swimlane, and it is why
 * this file resolves the cascade for real instead of asserting class lists
 * alone: it parses the generated stylesheet, matches each rule's selector
 * against the classes a path produces, and takes the winner by specificity with
 * last-one-wins on ties — which is what the browser does.
 *
 * Run with `pnpm test`; the module is bundled on the fly so the test reads the
 * same source the browser half does.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const stage = await mkdtemp(path.join(tmpdir(), 'scm-fileicons-'))
const bundled = path.join(stage, 'fileIcons.cjs')

// `pnpm test` always bundles. A harness that cannot spawn esbuild's service —
// a sandbox that forbids the pipe it talks over — can point this at a bundle
// the esbuild CLI produced instead.
const prebuilt = process.env.SCM_FILEICONS_BUNDLE
if (prebuilt === undefined) {
  await build({
    entryPoints: [path.join(root, 'src', 'client', 'fileIcons.ts')],
    outfile: bundled,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    logLevel: 'error',
    loader: { '.woff': 'dataurl' },
  })
}

const { fileIconClasses, fileIconsStylesheet } = await import(pathToFileURL(prebuilt ?? bundled).href)
await rm(stage, { recursive: true, force: true })

const theme = JSON.parse(await readFile(path.join(root, 'assets', 'fileicons', 'vs-seti-icon-theme.json'), 'utf8'))
const stylesheet = fileIconsStylesheet()

/** The two roots the generated rules are qualified by. */
const DARK_ROOT = '.dsh-scm.show-file-icons'
const LIGHT_ROOT = ".dsh-scm[data-scheme='light'].show-file-icons"

/**
 * The class names one compound selector targets.
 *
 * The generator escapes class names with the CSSOM algorithm, so a name may
 * carry a hex escape — `\33 ds-ext-file-icon` is the class
 * `3ds-ext-file-icon`, and `_spec\.ts-ext-file-icon` is one class, not two.
 * Splitting on `.` would misread both, and misreading them would mis-weigh the
 * cascade this test exists to check.
 */
function classesOf(compound) {
  assert.ok(compound.endsWith('::before'), `compound does not target the glyph: ${compound}`)
  const text = compound.slice(0, -'::before'.length)
  const names = []
  for (let index = 0; index < text.length; ) {
    assert.equal(text[index], '.', `unexpected selector syntax in ${compound}`)
    index += 1
    let name = ''
    while (index < text.length && text[index] !== '.') {
      if (text[index] !== '\\') {
        name += text[index]
        index += 1
        continue
      }
      index += 1
      const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(index, index + 6))
      if (hex === null) {
        name += text[index]
        index += 1
      } else {
        name += String.fromCodePoint(Number.parseInt(hex[0], 16))
        index += hex[0].length
        // A hex escape swallows one space after it, as its terminator.
        if (text[index] === ' ') index += 1
      }
    }
    names.push(name)
  }
  assert.notEqual(names.length, 0, `compound has no class: ${compound}`)
  return names
}

/** The class and attribute selectors one selector carries. */
function specificity(selector) {
  return (selector.match(/\.|\[/g) ?? []).length
}

/** The rules of a generated stylesheet, in document order. */
function rules(css) {
  const parsed = []
  for (const line of css.split('\n')) {
    if (line.startsWith('@font-face')) continue
    const open = line.indexOf(' { ')
    if (open < 0) throw new Error(`unparsable rule: ${line.slice(0, 120)}`)
    parsed.push({ selectors: line.slice(0, open).split(', '), body: line.slice(open + 3, -2) })
  }
  return parsed
}

/**
 * Resolve the cascade for one path, the way a browser would.
 *
 * The qualifier is an ancestor of the icon element, so it contributes only to
 * specificity; the compound after it is matched against the element's classes.
 * @param file - the repository-relative path.
 * @param scheme - which colour scheme the panel is in.
 * @returns the winning declaration block.
 */
function winner(file, scheme = 'dark') {
  const classes = new Set(fileIconClasses(file))
  const allowed = scheme === 'light' ? [DARK_ROOT, LIGHT_ROOT] : [DARK_ROOT]
  let best = null
  for (const rule of rules(stylesheet)) {
    for (const selector of rule.selectors) {
      // The qualifier is matched as a literal rather than by splitting on the
      // space: a hex escape inside a class name may contain one.
      const root = allowed.find((candidate) => selector.startsWith(`${candidate} `))
      if (root === undefined) continue
      const compound = selector.slice(root.length + 1)
      const matches = classesOf(compound).every((name) => classes.has(name))
      if (!matches) continue
      const weight = specificity(root) + classesOf(compound).length
      // `>=` rather than `>`: equal specificity is settled by document order.
      if (best === null || weight >= best.weight) best = { weight, body: rule.body }
    }
  }
  assert.notEqual(best, null, `nothing matched ${file}`)
  return best.body
}

/**
 * Assert a path resolves to the definition the theme assigns to a given key.
 * @param file - the path to resolve.
 * @param definition - the theme's `iconDefinitions` id the path should reach.
 */
function resolvesTo(file, definition) {
  const expected = theme.iconDefinitions[definition]
  assert.notEqual(expected, undefined, `${definition} is not a definition in the lifted theme`)
  const body = winner(file)
  assert.ok(
    body.includes(`content: '${expected.fontCharacter}';`),
    `${file} should reach ${definition} (${expected.fontCharacter}) but resolved to ${body}`,
  )
  assert.ok(
    body.includes(`color: ${expected.fontColor};`),
    `${file} should reach ${definition} (${expected.fontColor}) but resolved to ${body}`,
  )
}

// ---------- the class list, as `getIconClasses` computes it ----------

assert.deepEqual(fileIconClasses('README.md'), [
  'file-icon',
  'readme.md-name-file-icon',
  'name-file-icon',
  'md-ext-file-icon',
  'ext-file-icon',
  'markdown-lang-file-icon',
])

// The immediate parent directory is a class of its own, and only the immediate
// one — a theme may key an association off it.
assert.deepEqual(fileIconClasses('src/client/fileIcons.ts'), [
  'file-icon',
  'client-name-dir-icon',
  'fileicons.ts-name-file-icon',
  'name-file-icon',
  'ts-ext-file-icon',
  'ext-file-icon',
  'typescript-lang-file-icon',
])

// Every dot suffix becomes an extension class, longest first, so `spec.ts`
// outranks `ts` on the cascade rather than on a lookup table.
assert.deepEqual(fileIconClasses('foo.spec.ts'), [
  'file-icon',
  'foo.spec.ts-name-file-icon',
  'name-file-icon',
  'spec.ts-ext-file-icon',
  'ts-ext-file-icon',
  'ext-file-icon',
  'typescript-lang-file-icon',
])

// A name with no dot has no extension to match on, which is what makes the
// language leg the only way `Makefile` can be reached.
assert.deepEqual(fileIconClasses('Makefile'), [
  'file-icon',
  'makefile-name-file-icon',
  'name-file-icon',
  'ext-file-icon',
  'makefile-lang-file-icon',
])

// ---------- the cascade ----------

resolvesTo('README.md', theme.fileNames['readme.md'])
resolvesTo('src/vs/workbench/scmViewPane.ts', theme.languageIds.typescript)
resolvesTo('src/vs/base/common/uri.ts', theme.languageIds.typescript)
resolvesTo('foo.spec.ts', theme.fileExtensions['spec.ts'])
resolvesTo('foo.spec.js', theme.fileExtensions['spec.js'])
resolvesTo('Makefile', theme.languageIds.makefile)
resolvesTo('LICENSE', theme.fileNames['license'])
resolvesTo('tsconfig.json', theme.fileNames['tsconfig.json'])
// `.gitignore` has no extension rule either: the theme names the *language*
// `ignore`, and the generated table is what reaches it.
resolvesTo('.gitignore', theme.languageIds.ignore)
resolvesTo('styles/site.css.map', theme.fileExtensions['css.map'])
resolvesTo('hacks/thing.h++', theme.fileExtensions['h++'])
// A leading digit is escaped as a hex sequence in the selector, which is the
// one shape a naive split of a selector on `.` or a space gets wrong.
resolvesTo('models/thing.3ds', theme.fileExtensions['3ds'])

// A name the theme knows beats the extension and the language it also matches.
assert.equal(winner('README.md'), winner('docs/readme.md'))
assert.notEqual(winner('foo.spec.ts'), winner('foo.ts'))

// The language leg is load-bearing for this theme, not a fallback: Seti's
// `fileExtensions` has no entry for `ts`, `js`, `css` or `json`.
for (const [file, languageId] of [
  ['a.ts', 'typescript'],
  ['a.js', 'javascript'],
  ['a.jsx', 'javascriptreact'],
  ['a.tsx', 'typescriptreact'],
  ['a.css', 'css'],
  ['a.json', 'json'],
  ['a.sh', 'shellscript'],
  ['a.py', 'python'],
]) {
  assert.equal(theme.fileExtensions[file.split('.').pop()], undefined, `${file} should not have an extension rule`)
  resolvesTo(file, theme.languageIds[languageId])
}

// Anything unrecognised falls back to the theme's `file` icon.
resolvesTo('mystery.zzz', theme.file)
assert.match(winner('mystery.zzz'), new RegExp(`color: ${theme.iconDefinitions[theme.file].fontColor};`))

// ---------- light and dark ----------

// The light copy of a rule carries one more simple selector and so wins when
// both match — which is exactly how VS Code makes `.vs` win, and the reason a
// light theme needs no second stylesheet swap.
const lightBody = winner('a.ts', 'light')
assert.match(lightBody, new RegExp(`color: ${theme.iconDefinitions[theme.light.languageIds.typescript].fontColor};`))
assert.notEqual(lightBody, winner('a.ts', 'dark'))

// ---------- the stylesheet itself ----------

const fontFace = stylesheet.split('\n')[0]
assert.match(fontFace, /^@font-face \{/)
assert.match(fontFace, /font-family: 'seti'/)
assert.match(fontFace, /format\('woff'\)/)
assert.match(fontFace, /url\('data:font\/woff;base64,[A-Za-z0-9+/=]+'\)/)
assert.match(stylesheet, new RegExp(`${DARK_ROOT.replace(/\./g, '\\.')} \\.file-icon::before \\{ font-family: 'seti'; font-size: 150%; \\}`))

// Selectors are escaped, or a dot in an extension would split the class name
// and the rule would match nothing.
assert.ok(stylesheet.includes('.spec\\.ts-ext-file-icon'), 'spec.ts selector is escaped')
assert.ok(stylesheet.includes('.h\\+\\+-ext-file-icon'), 'h++ selector is escaped')
assert.ok(stylesheet.includes('.\\33 ds-ext-file-icon'), 'a leading digit is escaped')
assert.ok(stylesheet.includes(`${LIGHT_ROOT} .`), 'light rules are rooted at the light qualifier')

// No definition is emitted twice. The one selector that legitimately repeats is
// the default icon's: VS Code emits the font-family rule for `.file-icon` as
// well, so the two rules share a selector and set different properties.
const counts = new Map()
for (const rule of rules(stylesheet)) {
  for (const selector of rule.selectors) counts.set(selector, (counts.get(selector) ?? 0) + 1)
}
assert.deepEqual(
  [...counts].filter(([, count]) => count > 1).map(([selector]) => selector),
  [`${DARK_ROOT} .file-icon::before`],
)

console.log(`file icons ok — ${rules(stylesheet).length} rules, ${(stylesheet.length / 1024).toFixed(0)} KiB of stylesheet`)
