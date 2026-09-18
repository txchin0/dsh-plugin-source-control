/**
 * Lift VS Code's default file icon theme (Seti) into this plugin.
 *
 * The panel draws a file's icon the way VS Code does — it computes CSS classes
 * for the path and lets the cascade pick the winning rule — so it needs three
 * things that all live in a VS Code checkout:
 *
 *   1. `extensions/theme-seti/icons/vs-seti-icon-theme.json` — the theme.
 *   2. `extensions/theme-seti/icons/seti.woff`               — the glyph font.
 *   3. The language ids, because `getIconClasses` appends a
 *      `<languageId>-lang-file-icon` class and for this theme that leg is
 *      load-bearing, not a fallback: Seti's `fileExtensions` has no entry for
 *      `ts`, `js`, `css` or `json`. Those files match only through
 *      `languageIds.typescript`, `.javascript`, `.css` and `.json`.
 *
 * (3) is generated from the extension manifests rather than hand-written,
 * because guessing which language owns an extension is exactly the reasoning
 * AGENTS.md warns against. Entries the theme already covers through
 * `fileExtensions`/`fileNames` are dropped, which is lossless: an extension
 * rule carries one more class than a language rule, so it always wins the
 * cascade, and a name rule carries two more.
 *
 *   node tools/import-file-icons.mjs <path-to-vscode-checkout> [--check]
 *
 * `--check` re-derives everything and reports drift without writing, which is
 * what makes a VS Code bump a one-command re-lift.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetDir = path.join(root, 'assets', 'fileicons')
const vscode = process.argv[2]
const check = process.argv.includes('--check')

if (vscode === undefined || vscode.startsWith('--')) {
  console.error('usage: node tools/import-file-icons.mjs <path-to-vscode-checkout> [--check]')
  process.exit(2)
}

const themeSource = path.join(vscode, 'extensions', 'theme-seti', 'icons')
const theme = JSON.parse(await readFile(path.join(themeSource, 'vs-seti-icon-theme.json'), 'utf8'))

/** The checkout's revision, so the notice can name what was lifted. */
async function revision() {
  try {
    const head = await readFile(path.join(vscode, '.git', 'HEAD'), 'utf8')
    const ref = head.trim().replace(/^ref:\s*/, '')
    return (await readFile(path.join(vscode, '.git', ref), 'utf8')).trim()
  } catch {
    return '(unknown revision)'
  }
}

/** Every language id the theme can name, dark and light alike. */
function themeLanguageIds() {
  const ids = new Set(Object.keys(theme.languageIds ?? {}))
  for (const id of Object.keys(theme.light?.languageIds ?? {})) ids.add(id)
  return ids
}

/**
 * Collect `contributes.languages` from every extension manifest.
 * @returns language id to the extensions and file names it claims.
 */
async function declaredLanguages() {
  const declared = new Map()
  const dirents = await readdir(path.join(vscode, 'extensions'), { withFileTypes: true })
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(vscode, 'extensions', dirent.name, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    for (const language of manifest?.contributes?.languages ?? []) {
      if (typeof language?.id !== 'string') continue
      const entry = declared.get(language.id) ?? { extensions: [], filenames: [] }
      for (const extension of language.extensions ?? []) entry.extensions.push(extension.replace(/^\./, '').toLowerCase())
      for (const filename of language.filenames ?? []) entry.filenames.push(filename.toLowerCase())
      declared.set(language.id, entry)
    }
  }
  return declared
}

/**
 * Build the extension/filename table the language leg resolves against.
 *
 * Only languages the theme names are considered — an id with no entry in
 * `languageIds` produces a class no rule matches. Ids no built-in extension
 * declares (third-party languages such as `vue` and `terraform`) contribute
 * nothing, which is the same outcome as stock VS Code without that extension
 * installed.
 * @param declared - the manifests' language contributions.
 * @returns the sorted table, plus any entry two languages both claimed.
 */
function buildTable(declared) {
  const coveredExtensions = new Set(Object.keys(theme.fileExtensions ?? {}))
  const coveredFilenames = new Set(Object.keys(theme.fileNames ?? {}))
  const extensions = new Map()
  const filenames = new Map()
  const conflicts = []

  for (const languageId of [...themeLanguageIds()].sort()) {
    const entry = declared.get(languageId)
    if (entry === undefined) continue
    for (const extension of entry.extensions) {
      if (extension === '' || coveredExtensions.has(extension)) continue
      const known = extensions.get(extension)
      if (known !== undefined) {
        if (known !== languageId) conflicts.push(`extension "${extension}": ${known} vs ${languageId}`)
        continue
      }
      extensions.set(extension, languageId)
    }
    for (const filename of entry.filenames) {
      if (filename === '' || coveredFilenames.has(filename)) continue
      const known = filenames.get(filename)
      if (known !== undefined) {
        if (known !== languageId) conflicts.push(`filename "${filename}": ${known} vs ${languageId}`)
        continue
      }
      filenames.set(filename, languageId)
    }
  }

  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)))
  return { extensions: sorted(extensions), filenames: sorted(filenames), conflicts }
}

/** The notice both lifted artifacts are redistributed under. */
function notice(revision) {
  return `File icon assets in this directory
================================

vs-seti-icon-theme.json and seti.woff are taken verbatim from the VS Code
extension "vscode-theme-seti" (extensions/theme-seti), revision
${revision}.

  Copyright (c) Microsoft Corporation. Licensed under the MIT License.

The icon glyphs are Seti UI, by Jesse Weed:

  Copyright (c) 2014 Jesse Weed

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

vscode-language-ids.json is generated by tools/import-file-icons.mjs from the
same checkout's extension manifests. It carries no third-party content of its
own: it is a list of file extensions and language ids.
`
}

const table = buildTable(await declaredLanguages())
if (table.conflicts.length > 0) {
  console.error(`the manifests disagree about ${table.conflicts.length} entry/entries; first wins, deterministically:`)
  for (const conflict of table.conflicts) console.error(`  ${conflict}`)
}

// The theme and its font are copied verbatim; only the language table and the
// notice are written, and both are compared byte for byte by `--check`.
const written = [
  { path: path.join(assetDir, 'vscode-language-ids.json'), text: `${JSON.stringify(table, null, 2)}\n` },
  { path: path.join(assetDir, 'NOTICE'), text: notice(await revision()) },
]
// The theme JSON and its font are lifted verbatim, except for line endings: a
// Windows checkout of VS Code hands the JSON over with CRLF, while this
// repository normalises text to LF (`* text=auto eol=lf`). Storing what git
// would rewrite on the next checkout would leave `--check` reporting drift that
// never goes away, and LF is what VS Code's own repository holds. The font is a
// binary and is copied byte for byte.
const copied = ['seti.woff'].map((name) => ({
  from: path.join(themeSource, name),
  to: path.join(assetDir, name),
}))
const themeJson = path.join(assetDir, 'vs-seti-icon-theme.json')
const themeText = (await readFile(path.join(themeSource, 'vs-seti-icon-theme.json'), 'utf8')).replaceAll('\r\n', '\n')

if (check) {
  let drift = 0
  for (const artifact of [...written, { path: themeJson, text: themeText }]) {
    const current = await readFile(artifact.path, 'utf8').catch(() => null)
    if (current !== artifact.text) {
      console.error(`drift: ${path.relative(root, artifact.path)}`)
      drift += 1
    }
  }
  for (const artifact of copied) {
    const current = await readFile(artifact.to).catch(() => null)
    if (current === null || !current.equals(await readFile(artifact.from))) {
      console.error(`drift: ${path.relative(root, artifact.to)}`)
      drift += 1
    }
  }
  console.log(
    `checked ${written.length + copied.length + 1} artifacts, ${table.conflicts.length} conflict(s), ${drift} drifted`,
  )
  process.exit(drift === 0 ? 0 : 1)
}

await mkdir(assetDir, { recursive: true })
for (const artifact of written) await writeFile(artifact.path, artifact.text)
await writeFile(themeJson, themeText)
for (const artifact of copied) await copyFile(artifact.from, artifact.to)

console.log(
  `lifted ${themeLanguageIds().size} language ids, ` +
    `${Object.keys(table.extensions).length} extensions and ` +
    `${Object.keys(table.filenames).length} file names into assets/fileicons`,
)
