/**
 * File-icon check: what the Changes rows actually draw.
 *
 * The icons are decided by a CSS cascade that is generated at runtime from the
 * lifted Seti theme, so nothing about them is visible to a static check — the
 * stylesheet might be installed and match nothing, the font might not load, the
 * glyph might arrive as tofu, or the row's class list might reach the wrong
 * definition. All of those draw *something*. This step reads the computed
 * `::before` of real rows and compares it with the theme the plugin ships.
 *
 * Both colour schemes are checked on every run, whichever one the client
 * happens to be in: the theme carries a complete second set of definitions for
 * light, and the panel's `data-scheme` attribute is what selects between them,
 * so the step flips it and reads the page again. That also proves the two
 * things the theme's JSON cannot say on its own — that the glyph comes from the
 * bundled font, and that the icon box is VS Code's: a 16px glyph with 6px after
 * it, which is the whole of the space before the label.
 *
 * Environment:
 *   SCM_SESSION_INDEX  which session row to open, top to bottom (default 0)
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const theme = JSON.parse(await readFile(path.join(root, 'assets', 'fileicons', 'vs-seti-icon-theme.json'), 'utf8'))

/** The code point a definition's `fontCharacter` escape names. */
const glyphOf = (definition) => String.fromCodePoint(Number.parseInt(definition.fontCharacter.slice(1), 16))

/** `#519aba` as a browser reports it: `rgb(81, 154, 186)`. */
const rgbOf = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

/**
 * Files whose icon this check knows from the theme itself.
 *
 * Between them these span every leg of the resolution: `fileNames`, and
 * language ids for files whose extension the theme does not list at all — `ts`,
 * `json` and `css` are only reachable through `languageIds`, which is why they
 * are here.
 */
const EXPECTED = [
  { file: 'README.md', leg: 'fileNames', key: 'readme.md' },
  { file: 'AGENTS.md', leg: 'languageIds', key: 'markdown' },
  { file: 'package.json', leg: 'languageIds', key: 'json' },
  { file: 'tsconfig.json', leg: 'fileNames', key: 'tsconfig.json' },
  { file: '.gitignore', leg: 'languageIds', key: 'ignore' },
  { file: 'build.mjs', leg: 'languageIds', key: 'javascript' },
  { file: 'LICENSE', leg: 'fileNames', key: 'license' },
]

/**
 * The definition a scheme draws for one association.
 *
 * A scheme inherits whatever it does not override, which is not a convenience
 * of this helper: VS Code collects the light block's rules *in addition* to the
 * root's, so an association the light block omits keeps the root's rule.
 * @param scheme - `'dark'` or `'light'`.
 * @param leg - which association map the file is reached through.
 * @param key - the association's key.
 * @returns that scheme's definition for the association.
 */
function definitionFor(scheme, leg, key) {
  const override = scheme === 'light' ? theme.light?.[leg]?.[key] : undefined
  return theme.iconDefinitions[override ?? theme[leg][key]]
}

export default async function run(driver) {
  const trace = []
  const RIGHT = '[data-slot="rightbar.session"]'
  const sessionIndex = Number(process.env.SCM_SESSION_INDEX ?? 0)

  const step = async (name, action) => {
    try {
      trace.push({ step: name, result: await action() })
      return true
    } catch (error) {
      trace.push({ step: name, error: String(error.message) })
      return false
    }
  }
  const failures = []
  const check = async (name, action) => {
    if (!(await step(name, action))) failures.push(name)
  }

  // Only expanded workspaces list their sessions, and a fresh client's list
  // opens its workspaces already expanded where a used one's are collapsed —
  // so this only clicks when nothing is on screen.
  await check('expand workspaces', async () => {
    const VISIBLE_ROWS = `[...document.querySelectorAll('.YDXeBa_sessionRow')].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0).length`
    const already = await driver.probe(VISIBLE_ROWS)
    if (already > 0) return already
    const workspaces = await driver.probe(`document.querySelectorAll('.YDXeBa_projectRow').length`)
    for (let index = 0; index < workspaces; index += 1) {
      await driver.click({ selector: '.YDXeBa_projectRow', index })
      await driver.sleep(800)
    }
    const rows = await driver.probe(VISIBLE_ROWS)
    if (rows === 0) throw new Error('no session rows became visible')
    return rows
  })

  const rowIndex = await driver.probe(`(() => {
    const visible = (node) => node.offsetParent !== null && node.getBoundingClientRect().width > 0
    const rows = [...document.querySelectorAll('.YDXeBa_sessionRow')].filter(visible)
    const real = rows.filter((node) => (node.innerText || '').trim().toLowerCase() !== 'new session')
    const wanted = real[${sessionIndex}]
    return wanted === undefined ? -1 : rows.indexOf(wanted)
  })()`)
  if (rowIndex < 0) throw new Error(`no session row at index ${sessionIndex}`)
  await check('open session', () => driver.click({ selector: '.YDXeBa_sessionRow', index: rowIndex }))
  await driver.sleep(4000)

  await step('reveal right sidebar', async () => {
    try {
      await driver.click({ name: 'Open right sidebar' })
      await driver.sleep(2500)
      return 'revealed'
    } catch {
      return 'already open'
    }
  })

  await check('open Source Control', () => driver.click({ text: 'Source Control', within: RIGHT }))
  await driver.sleep(3500)

  // Read every row's icon out of the live page, once per colour scheme. The
  // attribute is the panel's own switch, and it is restored afterwards so the
  // reading does not depend on this probe having run.
  const sample = await driver.probe(`(() => {
    const panel = document.querySelector('.dsh-scm')
    if (panel === null) return null
    const read = () => [...panel.querySelectorAll('.dsh-scm-group .dsh-scm-row')].map((row) => {
      const icon = row.querySelector('.dsh-scm-row-icon')
      if (icon === null) return { path: (row.getAttribute('title') || '').split(' • ')[0], missing: true }
      const box = icon.getBoundingClientRect()
      const before = getComputedStyle(icon, '::before')
      const rowBox = row.getBoundingClientRect()
      const label = row.querySelector('.dsh-scm-label').getBoundingClientRect()
      return {
        path: (row.getAttribute('title') || '').split(' • ')[0],
        name: (row.getAttribute('title') || '').split(' • ')[0].split('/').pop(),
        classes: [...icon.classList],
        content: before.content.replace(/^"|"$/g, ''),
        color: before.color,
        fontFamily: before.fontFamily,
        fontSize: before.fontSize,
        iconWidth: Math.round(box.width),
        iconHeight: Math.round(box.height),
        // Where the label starts, measured from the row's own content edge, so
        // the row's list padding is not mistaken for icon geometry.
        labelOffset: Math.round(label.left - rowBox.left - Number.parseFloat(getComputedStyle(row).paddingLeft)),
      }
    })
    const original = panel.getAttribute('data-scheme')
    const mine = read()
    panel.setAttribute('data-scheme', original === 'light' ? 'dark' : 'light')
    const other = read()
    panel.setAttribute('data-scheme', original)
    return {
      scheme: original,
      active: original === 'light' ? mine : other,
      inactive: original === 'light' ? other : mine,
      inactiveScheme: original === 'light' ? 'dark' : 'light',
      hasRoot: panel.classList.contains('show-file-icons'),
      box: (() => { const r = panel.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })(),
    }
  })()`)

  if (sample === null) {
    failures.push('panel did not render')
    console.error(JSON.stringify(trace, null, 2))
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }

  const rows = sample.active
  trace.push({ step: 'scheme', result: { active: sample.scheme, flippedTo: sample.inactiveScheme } })
  trace.push({ step: 'rows', result: { count: rows.length, first: rows.slice(0, 4) } })

  await check('the panel root opts into file icons', async () => {
    if (!sample.hasRoot) throw new Error('the .dsh-scm root is missing show-file-icons')
    return true
  })

  await check('every row draws a themed glyph from the bundled font', async () => {
    if (rows.length === 0) throw new Error('no resource rows to check')
    const bad = rows.filter(
      (row) =>
        row.missing ||
        !row.classes.includes('file-icon') ||
        row.content.length !== 1 ||
        !row.fontFamily.toLowerCase().includes('seti') ||
        row.iconWidth !== 22 ||
        row.iconHeight !== 22,
    )
    if (bad.length > 0) throw new Error(`${bad.length} row(s) not drawn from the theme: ${JSON.stringify(bad.slice(0, 3))}`)
    return `${rows.length} rows, all 22x22 from seti (${rows[0].fontSize})`
  })

  await check('the label starts where VS Code puts it', async () => {
    const offsets = [...new Set(rows.map((row) => row.labelOffset))]
    if (offsets.length !== 1 || offsets[0] !== 22) {
      throw new Error(`label offsets past the row's padding: ${offsets.join(', ')} — expected 22`)
    }
    return `label at padding + ${offsets[0]}px`
  })

  await check('known files reach the definition each scheme assigns them', async () => {
    const matched = []
    const wrong = []
    for (const scheme of [sample.scheme, sample.inactiveScheme]) {
      const reading = scheme === sample.scheme ? sample.active : sample.inactive
      for (const expectation of EXPECTED) {
        const row = reading.find((candidate) => candidate.name === expectation.file)
        if (row === undefined) continue
        const definition = definitionFor(scheme, expectation.leg, expectation.key)
        const pass = row.content === glyphOf(definition) && row.color === rgbOf(definition.fontColor)
        const entry = { scheme, file: expectation.file, via: `${expectation.leg}.${expectation.key}`, pass, got: `${row.content} ${row.color}` }
        matched.push(entry)
        if (!pass) wrong.push(`${expectation.file} (${scheme})`)
      }
    }
    if (matched.length === 0) {
      throw new Error(`none of the known files are in this repository: ${rows.map((row) => row.path).join(', ')}`)
    }
    if (wrong.length > 0) throw new Error(`wrong icon for: ${wrong.join(', ')} — ${JSON.stringify(matched)}`)
    trace.push({ step: 'matched', result: matched })
    return matched
  })

  await check('the two schemes really do disagree', async () => {
    const changed = sample.active.filter((row, index) => row.color !== sample.inactive[index].color).length
    if (changed === 0) throw new Error('no row changed colour between the schemes')
    // The light rules win by carrying one more simple selector, so a row whose
    // light definition exists must take it rather than the dark one.
    const markdown = sample.active.find((row) => row.name === 'AGENTS.md')
    if (markdown === undefined) return `${changed} rows recoloured`
    const active = definitionFor(sample.scheme, 'languageIds', 'markdown')
    if (markdown.color !== rgbOf(active.fontColor)) {
      throw new Error(`AGENTS.md is ${markdown.color}, expected ${rgbOf(active.fontColor)}`)
    }
    return `${changed} of ${sample.active.length} rows recoloured`
  })

  await driver.park()
  const clip = {
    x: Math.round(sample.box.x),
    y: Math.round(sample.box.y),
    width: Math.round(sample.box.width),
    height: Math.min(Math.round(sample.box.height), 900),
  }
  trace.push({ step: 'screenshot', result: await driver.shot('file-icons', clip) })

  // The report never reaches stdout when a check throws, so a failing run says
  // what it saw here instead of leaving only the name of the check.
  if (failures.length > 0) {
    console.error(JSON.stringify(trace, null, 2))
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }
  return trace
}
